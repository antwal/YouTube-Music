/**
 * Created by nilsbergmann on 03.02.17.
 */
const log = require('./Logger')();
const request = require('request');
const async = require('async');
const url = require('url');
const fs = require('fs-extra');
const DL = require('./DownloadManager');
const path = require('path');
const {app} = require('electron');

let downloadTaskList = {};

module.exports = function (cfg) {
    log.info("Setup main process socket events");

    // Create vars
    const socket = cfg.socket;
    const window = cfg.mainWindow;
    const db = cfg.db;
    const DownloadManager = new DL(db, socket);

    socket.on('message:in library ?', (msg) => {
        const data = msg.data();
        if (data.id) {
            if (data.id.kind == "youtube#playlist") {
                db.findOne({
                    _id: data.id.playlistId
                }, (err, playlist) => {
                    if (err) throw err;
                    if (playlist && playlist.inLibrary) {
                        msg.reply({
                            inLibrary: true,
                            result: playlist
                        });
                    } else {
                        msg.reply({
                            inLibrary: false
                        });
                    }
                });
            } else if (data.id.kind == "youtube#video") {
                db.findOne({
                    _id: data.id.videoId
                }, (err, video) => {
                    if (err) throw err;
                    if (video && video.inLibrary) {
                        msg.reply({
                            inLibrary: true,
                            result: video
                        });
                    } else {
                        msg.reply({
                            inLibrary: false
                        });
                    }
                });
            }
        } else {
            msg.reply({
                error: "No id tag in data"
            });
        }

    });

    socket.on('message:add to library', (msg) => {
        const data = msg.data();
        if (!data.id) return msg.reply(null);
        if (data.id.kind == "youtube#playlist") {
            const PlayListItemURL = `https://www.googleapis.com/youtube/v3/playlistItems?key=AIzaSyAmrU02S7vOBKU2Ep6lpaGP9SW7y3K3KKQ&part=snippet&playlistId=${data.id.playlistId}`;
            request(PlayListItemURL, {
                json: true
            }, (error, response, body) => {
                if (!error && response.statusCode == 200) {
                    const pageCount = parseInt(body.pageInfo.totalResults / body.pageInfo.resultsPerPage);
                    if (body.nextPageToken) {
                        let next = body.nextPageToken;
                        let videos = [];
                        videos = videos.concat(body.items);
                        async.timesSeries(pageCount, (n, TimeCallback) => {
                            const NextPageURL = `https://www.googleapis.com/youtube/v3/playlistItems?key=AIzaSyAmrU02S7vOBKU2Ep6lpaGP9SW7y3K3KKQ&part=snippet&playlistId=${data.id.playlistId}&pageToken=${next}`;
                            request(NextPageURL, {
                                json: true
                            }, (error, NextPageResponse, NextPageBody) => {
                                if (!error && NextPageResponse.statusCode == 200) {
                                    if (NextPageBody.nextPageToken) {
                                        next = NextPageBody.nextPageToken;
                                    }
                                    videos = videos.concat(NextPageBody.items);
                                    TimeCallback();
                                } else {
                                    TimeCallback();
                                }
                            });
                        }, () => {
                            data.items = videos;
                            data.inLibrary = true;
                            data._id = data.id.playlistId;
                            delete data["$$hashKey"];
                            db.findOne({_id: data.id.playlistId}, (error, exists) => {
                                if (exists){
                                    db.update({_id: data.id.playlistId}, {$set: data}, {}, (error) => {
                                        if (error) throw error;
                                        msg.reply({});
                                    });
                                } else {
                                    db.insert(data, (error) => {
                                        if (error) throw error;
                                        msg.reply({});
                                    });
                                }
                            });
                        });
                    } else {
                        data.inLibrary = true;
                        data._id = data.id.playlistId;
                        delete data["$$hashKey"];
                        db.findOne({_id: data.id.playlistId}, (error, exists) => {
                            if (exists){
                                db.update({_id: data.id.playlistId}, {$set: data}, {}, (error) => {
                                    if (error) throw error;
                                    msg.reply({});
                                });
                            } else {
                                db.insert(data, (error) => {
                                    if (error) throw error;
                                    msg.reply({});
                                });
                            }
                        });
                    }
                } else {
                    msg.reply(null);
                }
            });
        } else if (data.id.kind == "youtube#video") {
            db.findOne({
                _id: data.id.videoId
            }, (error, doc) => {
                if (doc) {
                    db.update({_id: data.id.videoId}, {$set: {inLibrary: true}}, (error, newDoc) => {
                        log.info(`Video added to db. New data: `, newDoc);
                        msg.reply({});
                        socket.send('update library');
                    });
                } else {
                    log.info(`Add video with id ${data.id.videoId}`);
                    data._id = data.id.videoId;
                    data.inLibrary = true;
                    delete data["$$hashKey"];
                    db.insert(data, (error, newDoc) => {
                        if (error) throw error;
                        log.info(`Video added to db. New data: `, newDoc);
                        msg.reply({});
                        socket.send('update library');
                    });
                }
            });
        }
    });

    socket.on('message:remove from library', (msg) => {
        const data = msg.data();
        if (!data.id) return msg.reply(null);
        let id;
        if (data.id.kind == "youtube#playlist") {
            id = data.id.playlistId;
        } else if (data.id.kind == "youtube#video") {
            id = data.id.videoId;
        }
        const remove = function () {
            log.info(`Remove data with id ${id}`);
            db.update({_id: id}, {$set: {inLibrary: false}}, {}, (error) => {
                if (error) throw error;
                log.info(`Removed from library with id ${id}`);
                msg.reply(error);
            });
        };
        db.findOne({_id: id}, (error, doc) => {
            if (error) throw error;
            if (!doc) return msg.reply({});
            if (data.id.kind == "youtube#video") {
                if (data.RemoveDownload) {
                    if (!doc.VideoDownloaded) return remove();
                    const DownloadPath = path.join(app.getPath('userData'), 'downloads/' + data.id + '/');
                    fs.access(DownloadPath, fs.constants.W_OK, (error) => {
                        if (error) return remove();
                        fs.remove(DownloadPath, (error) => {
                            if (error) log.error(error);
                            let update = {};
                            update.VideoDownloaded = false;
                            update.Path = null;
                            async.eachOf(doc.snippet.thumbnails, (Value, Key, EOCallback) => {
                                update[`snippet.thumbnails.${Key}.Path`] = null;
                                update[`snippet.thumbnails.${Key}.Downloaded`] = false;
                                EOCallback();
                            }, (error) => {
                                if (error) log.error(error);
                                db.update({_id: data.id}, {$set: update}, {}, (error) => {
                                    if (error) log.error(error);
                                    remove();
                                });
                            });
                        });
                    });
                }
            } else if (data.id.kind == "youtube#playlist") {
                const RemoveItemDownloads = function (ItemsToRemove, FCallback) {
                    async.eachSeries(ItemsToRemove, (ToRemove, ECallback) => {
                        if (!ToRemove.snippet || !ToRemove.snippet.resourceId || !ToRemove.snippet.resourceId.videoId) return ECallback();
                        db.findOne({_id: ToRemove.snippet.resourceId.videoId}, (error, ToRemoveFromDB) => {
                            if (error || !ToRemoveFromDB || !ToRemoveFromDB.VideoDownloaded) return ECallback();
                            const DownloadPath = path.join(app.getPath('userData'), 'downloads/' + ToRemoveFromDB.id + '/');
                            log.info(DownloadPath);
                            fs.access(DownloadPath, fs.constants.W_OK, (error) => {
                                const MarkAsNotDownloaded = function () {
                                    log.info(`Mark ${ToRemoveFromDB.id} as not downloaded.`);
                                    let update = {};
                                    update.VideoDownloaded = false;
                                    update.Path = null;
                                    async.eachOf(ToRemoveFromDB.snippet.thumbnails, (Value, Key, EOCallback) => {
                                        update[`snippet.thumbnails.${Key}.Path`] = null;
                                        update[`snippet.thumbnails.${Key}.Downloaded`] = false;
                                        EOCallback();
                                    }, (error) => {
                                        if (error) log.error(error);
                                        db.update({_id: ToRemoveFromDB.id}, {$set: update}, {}, (error) => {
                                            if (error) log.error(error);
                                            ECallback();
                                        });
                                    });
                                };
                                if (error) {
                                    MarkAsNotDownloaded();
                                } else {
                                    log.info(`Remove downloaded files of ${ToRemoveFromDB.id.videoId}.`);
                                    fs.remove(DownloadPath, (error) => {
                                        if (error) log.error(error);
                                        MarkAsNotDownloaded();
                                    });
                                }

                            });
                        });
                    }, (error) => {
                        if (error) log.error(error);
                        FCallback();
                    });
                };
                if (data.RemoveOnly) {
                    RemoveItemDownloads(data.RemoveOnly, () => {
                        remove();
                    });
                } else {
                    db.findOne({_id: data.id.playlistId}, (error, doc) => {
                        if (error) throw error;
                        RemoveItemDownloads(doc.items, () => {
                            remove();
                        });
                    });
                }
            } else {
                msg.reply({});
            }
        });
    });

    socket.on('message:get video informations', (msg) => {
        const data = msg.data();
        db.findOne({_id: data.videoId}, (err, doc) => {
            if (doc) {
                msg.reply(doc);
            } else {
                request(`https://www.googleapis.com/youtube/v3/videos?key=AIzaSyAmrU02S7vOBKU2Ep6lpaGP9SW7y3K3KKQ&part=snippet&id=${data.videoId}`, {json: true}, (error, response, body) => {
                    if (!error && response.statusCode == 200) {
                        msg.reply(body.items[0]);
                    } else {
                        msg.reply({error: "Can not get video informations"});
                    }
                });
            }
        });
    });

    socket.on('message:get playlist informations', (msg) => {
        const data = msg.data();
        db.findOne({_id: data.playlistId}, (err, doc) => {
            if (doc) {
                msg.reply(doc);
            } else {
                let Params = {
                    part: "snippet",
                    key: "AIzaSyAmrU02S7vOBKU2Ep6lpaGP9SW7y3K3KKQ",
                    playlistId: data.playlistId
                };
                let FirstURL = url.parse('https://www.googleapis.com/youtube/v3/playlistItems');
                FirstURL.query = Params;
                request(url.format(FirstURL), {
                    json: true
                }, (error, response, body) => {
                    if (!error && response.statusCode == 200) {
                        const pageCount = parseInt(body.pageInfo.totalResults / body.pageInfo.resultsPerPage);
                        if (body.nextPageToken) {
                            let next = body.nextPageToken;
                            let videos = [];
                            videos = videos.concat(body.items);
                            async.timesSeries(pageCount, (n, TimeCallback) => {
                                let Params = {
                                    part: "snippet",
                                    key: "AIzaSyAmrU02S7vOBKU2Ep6lpaGP9SW7y3K3KKQ",
                                    playlistId: data.playlistId,
                                    pageToken: next
                                };
                                let PlayListRequestURL = url.parse('https://www.googleapis.com/youtube/v3/playlistItems');
                                PlayListRequestURL.query = Params;
                                request(url.format(PlayListRequestURL), {
                                    json: true
                                }, (error, response, xBody) => {
                                    if (!error && response.statusCode == 200) {
                                        if (xBody.nextPageToken) {
                                            next = xBody.nextPageToken;
                                        }
                                        videos = videos.concat(xBody.items);
                                        TimeCallback();
                                    } else {
                                        TimeCallback();
                                    }
                                });
                            }, () => {
                                data.items = videos;
                                data._id = data.playlistId;
                                msg.reply(data);
                            });
                        } else {
                            // Error
                        }
                    } else {
                        // Error
                    }
                });
            }
        });
    });

    socket.on('message:get all playlists', (msg) => {
        db.find({inLibrary: true}, (error, docs) => {
            if (error) throw error;
            if (!error) {
                if (docs) {
                    let returnResults = [];
                    for (let Index in docs) {
                        if (docs.hasOwnProperty(Index)) {
                            if (docs[Index].id) {
                                if (docs[Index].id.kind == "youtube#playlist") {
                                    returnResults.push(docs[Index])
                                }
                            }
                        }
                    }
                    msg.reply(returnResults);
                } else {
                    msg.reply([]);
                }
            }
        });
    });

    socket.on('message:get all songs', (msg) => {
        db.find({inLibrary: true}, (error, docs) => {
            if (error) throw error;
            if (!error) {
                if (docs) {
                    let returnResults = [];
                    for (let Index in docs) {
                        if (docs.hasOwnProperty(Index)) {
                            if (docs[Index].id) {
                                if (docs[Index].id.kind == "youtube#video") {
                                    returnResults.push(docs[Index])
                                }
                            }
                        }
                    }
                    msg.reply(returnResults);
                } else {
                    msg.reply([]);
                }
            }
        });
    });

    socket.on('event:Start download of', (msg) => {
        log.info(`Start download`, msg);
        let add = {
            kind: msg.kind
        };
        if (msg.videoId) {
            add.videoId = msg.videoId;
        }
        if (msg.playlistId) {
            add.playlistId = msg.playlistId;
        }
        log.info(msg);
        DownloadManager.this().task.push(add);
    });

    socket.on('message:get all downloaded songs', (msg) => {
        db.find({VideoDownloaded: true}, (error, Docs) => {
            if (error) throw error;
            msg.reply(Docs);
        });
    });

    socket.on('message:re-download with id', (msg) => {
        if (msg.data().kind && msg.data().kind == "youtube#video") {
            async.waterfall([
                (WCallback) => {
                    RemoveOnlyDownload(msg.data().videoId, WCallback)
                },
                (WCallback) => {
                    DownloadManager.this().task.push({
                        kind: "youtube#video",
                        videoId: msg.data().videoId
                    });
                    WCallback();
                }
            ], (error) => {
                msg.reply(error);
            })
        } else if (msg.data().kind && msg.data().kind == "youtube#playlist") {
            // Todo: Need to add playlist
        } else {
            msg.reply();
        }
    });

    socket.on('message:remove download', (msg) => {
        RemoveOnlyDownload(msg.data().videoId, () => {
            msg.reply();
        })
    });

    function RemoveOnlyDownload(videoId, FCallback) {
        async.waterfall([
            (WCallback) => {
                log.info(videoId);
                db.findOne({_id: videoId}, (error, Doc) => {
                    if (!error && Doc) {
                        WCallback(null, Doc);
                    } else {
                        WCallback(error || "Nothing found");
                    }
                });
            },
            (Video, WCallback) => {
                if (Video.VideoPath) {
                    fs.access(Video.VideoPath, fs.constants.R_OK | fs.constants.W_OK, (error) => {
                        if (!error) {
                            fs.remove(Video.VideoPath, (error) => {
                                WCallback(error, Video);
                            });
                        } else {
                            WCallback(null, Video);
                        }
                    });
                } else {
                    WCallback(null, Video);
                }
            },
            (Video, WCallback) => {
                if (Video.snippet && Video.snippet.thumbnails) {
                    let Keys = [];
                    async.eachOf(Video.snippet.thumbnails, (Value, Key, ECallback) => {
                        Keys.push(Key);
                        if (Value.Path) {
                            fs.access(Value.Path, fs.constants.R_OK | fs.constants.W_OK, (error) => {
                                if (!error) {
                                    fs.remove(Value.Path, ECallback);
                                } else {
                                    ECallback();
                                }
                            });
                        } else {
                            ECallback();
                        }
                    }, (error) => {
                        WCallback(error, Video, Keys);
                    });
                } else {
                    WCallback(null, Video);
                }
            },
            (Video, ThumbnailKeys, WCallback) => {
                let update = {
                    VideoPath: null,
                    VideoDownloaded: false
                };
                for (let TIndex in ThumbnailKeys) {
                    if (ThumbnailKeys.hasOwnProperty(TIndex)) {
                        update[`snippet.thumbnails.${ThumbnailKeys[TIndex]}.Downloaded`] = null;
                        update[`snippet.thumbnails.${ThumbnailKeys[TIndex]}.Path`] = null;
                    }
                }
                db.update({_id: videoId}, {$set: update}, {}, (error) => {
                    WCallback(error);
                });
            }
        ], (error) => {
            FCallback(error);
        });
    }
};