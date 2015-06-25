var chalk = require('chalk');
var util = require('../lib/util');
var config = require('../lib/config');
var formattor = require('formattor');
var clui = require('clui');
var _ = require('lodash');
var loading = new clui.Spinner('Please wait...');
var Q = require('q');
var fs = require('fs-extra');
var readFile = Q.denodeify(fs.readFile);
var writeFile = Q.denodeify(fs.writeFile);
var remove = Q.denodeify(fs.remove);
var move = Q.denodeify(fs.move);
var mkdirp = Q.denodeify(fs.mkdirp);
var exists = Q.denodeify(fs.exists);
var path = require('path');
var extract = require('extract-zip');
var inquirer = require("inquirer");
var os = require('os');

var Command = require('ronin').Command;

var bbrest, jxon, cfg;

module.exports = Command.extend({
    help: function () {
        var title = chalk.bold;
        var d = chalk.gray;
        var r = '\n  ' + title('Usage') + ': bb ' + this.name + ' [OPTIONS]';
        r += '\n\t Exports portal.';
        r += '\n\n  ' + title('Options') + ': -short, --name <type> ' + d('default') + ' description';
        r += '\n\t  All `bb rest` options for configuring portal, context, username etc are valid.\n\n';
        r += '      -s,  --save <string>\t\t' + '\t\tFile or dir to save the export to.\n';
        r += '      -t,  --type <string>\t\t' + d('model') + '\t\tWhat to export: model(portal without content), portal, widget, container\n';
        r += '      -n,  --name <string>\t\t\t\tName of the widget or container to export.\n';
        r += '      -C,  --item-context <string>\t' + d('[BBHOST]') + '\tContext of the widget or container that is to be exported.\n';
        r += '           --pretty <boolean>\t\t' + d('true') + '\t\tPrettify the output.\n';
        r += '      -k,  --chunk <boolean>\t\t' + d('false') + '\t\tParse output and chunk it into multiple files.\n';
        r += '      -f,  --force <boolean>\t\t' + d('false') + '\t\tForce overwrite.\n\n';

        r += '      -H,  --host <string>\t\t' + d('localhost') + '\tThe host name of the server running portal foundation.\n';
        r += '      -P,  --port <number>\t\t' + d('7777') + '\t\tThe port of the server running portal foundation.\n';
        r += '      -c,  --context <string>\t\t' + d('portalserver') + '\tThe application context of the portal foundation.\n';
        r += '      -u,  --username <string>\t\t' + d('admin') + '\t\tUsername.\n';
        r += '      -w,  --password <string>\t\t' + d('admin') + '\t\tPassword.\n';
        r += '      -p,  --portal <string>\t\t\t\tName of the portal on the server to target.\n';
        r += '\n  ' + title('Examples') + ':\n\n';
        r += '      bb export \t\t\t\t\t\t\t\tOutputs prettified, sorted xml file.\n';
        r += '      bb export --save myPortal.xml\t\t\t\t\t\tSaves prettified, sorted export to myPortal.xml\n';
        r += '      bb export --portal my-portal --save myPortal.xml -k\t\t\tSaves export to myPortal.xml and chunks to ./myPortal dir\n';
        r += '      bb export --type portal --save retail.zip\t\t\t\t\tSaves export including content to retail.zip\n';
        r += '      bb export --type portal --portal retail-banking --save retail.zip -k\tSaves export including content to retail.zip and chunks into ./retail dir\n';
        r += '      bb export -s accounts.zip --type widget --name accounts -C [BBHOST] -k\tExports widget and prettify/chunk the model in accounts dir\n';
        return r;
    },

    options: {
        save: {type: 'string', alias: 's'},
        type: {type: 'string', alias: 't', default: 'model'},
        name: {type: 'string', alias: 'n'},
        'item-context': {type: 'string', alias: 'C'},
        pretty: {type: 'boolean', default: true},
        chunk: {type: 'boolean', alias: 'k', default: false},
        force: {type: 'boolean', alias: 'f', default: false}
    },

    run: function () {

        return config.getCommon(this.options)
        .then(function(r) {
            bbrest = r.bbrest;
            jxon = r.jxon;
            cfg = r.config.cli;
            jxon.config({parseValues: false});

            // check if save destination is proper
            return checkSave()
            .then(function() {

                return getPortal()
                .then(function(portal) {
                    bbrest.config.portal = portal;

                    var action = 'post';
                    var jx;

                    switch (cfg.type) {
                        case 'portal':
                            jx = {exportRequest: {portalExportRequest: {
                                portalName: bbrest.config.portal,
                                includeContent: true,
                                includeGroups: true
                            }}};
                            break;
                        case 'widget':
                            jx = {exportRequest: {widgetExportRequest: {
                                widgetName: cfg.name,
                                contextItemName: cfg.C || '[BBHOST]',
                                includeContent: true,
                                includeGroups: true,
                                includeSharedResources: true
                            }}};
                            break;
                        case 'container':
                            jx = {exportRequest: {containerExportRequest: {
                                containerName: cfg.name,
                                contextItemName: cfg.C || '[BBHOST]',
                                includeContent: true,
                                includeGroups: true,
                                includeSharedResources: true
                            }}};
                            break;
                        default:
                            if (cfg.type !== 'model') return error(new Error('Wrong export type: ' + chalk.gray(cfg.type)));
                            action = 'get';
                            break;
                    }

                    loading.start();
                    if (action === 'post') {
                        runOrchestratorExport(jx);
                    } else {
                        return bbrest.export().get()
                        .then(function(r) {
                            if (r.error) return error(r);
                            return handlePortalXml(_.unescape(r.body))
                            .then(function(r) {
                                loading.stop();
                                if (typeof r === 'string') console.log(r);
                                else ok(r);
                            });
                        }).catch(error);
                    }

                });

            });

        }).catch(error);
    }
});

function checkSave() {
    if (cfg.type === 'model' && !cfg.save) return Q(true);

    return exists(cfg.save)
    .catch(function() {
        if (cfg.force) return remove(cfg.save);
        throw new Error(chalk.gray(cfg.save) + ' exists. Use --force(-f) flag to overwrite it.');
    });
}

function getPortal() {
    if (bbrest.config.portal) return Q(bbrest.config.portal);

    if (cfg.type === 'widget' || cfg.type === 'container') return Q('');

    return bbrest.server().get()
    .then(function(v) {
        v = jxon.stringToJs(_.unescape(v.body));

        if (v.portals.portal instanceof Array) {
            var portals = _.pluck(v.portals.portal, 'name');
            var defer = Q.defer();
            inquirer.prompt([{
                message: 'Choose the portal you want to export',
                name: 'name',
                type: 'list',
                choices: portals
            }], function (answers) {
                defer.resolve(answers.name);
            });
            return defer.promise;
        }
        return Q(v.portals.portal.name);

    });
}

function runOrchestratorExport(jx) {
    var toPost = cfg.file || jx;

    return bbrest.export().post(toPost)
    .then(function(r) {
        if (r.error) {
            return error(new Error('Error while exporting from Orchestrator'));
        }
        var id = jxon.stringToJs(_.unescape(r.body)).exportResponse.identifier;
        var savePath = cfg.chunk ? path.resolve(os.tmpdir(), 'bb_export_tmp') : cfg.save;
        return bbrest.export(id).file(savePath).get()
        .then(function(r) {
            if (cfg.chunk) {
                return unzip(savePath, cfg.save)
                .then(function() {
                    var exDir = path.parse(id).name;
                    var exPath = path.resolve(cfg.save, exDir);
                    var xmlPath = path.resolve(exPath, 'portalserver.xml');
                    return readFile(xmlPath)
                    .then(function(x) {
                        return handlePortalXml(x.toString(), path.resolve(cfg.save, 'metadata.xml'))
                        .then(function() {
                            var content = (cfg.type === 'portal') ? 'contentservices.zip' : 'resource.zip';
                            return move(path.resolve(exPath, content), path.resolve(cfg.save, content))
                            .fin(function() {
                                return remove(exPath)
                                .then(ok);
                            })
                            .catch(function() {

                            });
                        });
                    });
                });
            } else {
                return ok(r);
            }
        });
    }).catch(error);
}

function error(err) {
    loading.stop();
    util.err(chalk.red('bb export: ') + (err.message || err.error));
}
function ok(r) {
    loading.stop();
    util.ok('Writing to ' + chalk.green(cfg.save) + '. Done.');
    return r;
}

function handlePortalXml(x, metaFile) {
    var jx = sort(jxon.stringToJs(x));
    if (cfg.save) {
        if (cfg.chunk) {
            return chunkXml(jx, metaFile);
        } else {
            if (cfg.pretty) x = formattor(x, {method: 'xml'});
            return writeFile(cfg.s, jxon.jsToString(jx));
        }
    }
    if (cfg.pretty) x = formattor(jxon.jsToString(jx), {method: 'xml'});
    return Q(x);
}

function unzip(src, dir) {
    var defer = Q.defer();

    return remove(dir)
    .then(function() {
        extract(src, {dir: dir}, function(err) {
            if (err) defer.reject(err);
            else {
                defer.resolve(true);
            }
        });
        return defer.promise;
    });
}

function getMeta(metaPath) {
    return readFile(metaPath)
    .then(function(ms) {
        return remove(metaPath)
        .then(function() {
            return jxon.stringToJs(ms.toString());
        });
    })
    .catch(function() {
        return {
            backbaseArchiveDescriptor: {}
        };
    });
}

function chunkXml(jx, metaFile) {
    return getMeta(metaFile)
    .then(function(metaFile) {
        if (_.isEmpty(metaFile.backbaseArchiveDescriptor)) {
            metaFile.backbaseArchiveDescriptor = {
                includesContent: false
            };
        }
        var meta = metaFile.backbaseArchiveDescriptor.bbexport = {};
        meta.exportBundle = {};
        var all = [];
        var order = [];

        _.each(jx.exportBundle, function(v, k) {
            order.push(k);
            if (typeof v === 'object') {
                var n = {};
                n[k] = v;
                all.push(saveFile(path.resolve(cfg.save, _.kebabCase(k) + '.xml'), jxon.jsToString(n)));
            }
        });

        meta.order = order.join(',');
        all.push(saveFile(path.resolve(cfg.save, 'metadata.xml'), jxon.jsToString(metaFile)));
        return Q.all(all);
    });
}

// saves files to destination folder when they are chunks
function saveFile(fileName, x) {
    if (cfg.pretty) x = formattor(x, {method: 'xml'});
    return writeFile(fileName, x)
    .catch(function(err) {
        if (err.code === 'ENOENT') {
            return mkdirp(cfg.save)
            .then(function() {
                return saveFile(fileName, x);
            });
        } else return err;
    });
}

function sort(jx) {
    _.each(jx.exportBundle, function(v) {
        if (typeof v === 'object') {
            v = sortItems(v);
        }
    });
    return jx;
}

function sortItems(items) {
    var key = _.keys(items)[0];
    var col = items[key];

    // items that have no name: bundleRight, contentItemRef
    // warning: if there is only one object in collection it is returned as object not as array of objects

    // console.log('---', key);
    if (col instanceof Array) {
        if (key === 'bundleRight') col = _.sortBy(col, 'itemName');
        else if (key === 'contentItemRef') col = _.sortBy(col, '$itemName');
        else col = _.sortBy(col, 'name');

        _.each(col, function(v, k) {
            col[k] = sortItem(v);
        });
    } else {
        col = sortItem(col);
    }
    return items;
}

function sortItem(item) {
    if (item.properties && item.properties.property) {
        item = sanitizeItem(item);
        if (item.properties && item.properties.property.length > 1) {
            item.properties.property = _.sortBy(item.properties.property, '$name');
        }
    } else if (item.rights && item.rights.itemRight) {
        item.rights.itemRight = _.sortBy(item.rights.itemRight, '$name');
        item.rights.propertyRight = _.sortBy(item.rights.propertyRight, '$name');
    }
    if (item.tags && item.tags.tag) {
        item.tags.tag = _.sortByAll(item.tags.tag, ['_', '$type', '$blacklist']);
    }
    return item;
}

/**
 * Removes all unwanted inherited values and generated model from remote items
 * So they can be compared with clean local model
 * @param {object} item
 * @returns {object} new cleaned item
 */
function sanitizeItem(item) {

    // Only for templates, but not validating item type here
    var fieldWhitelist = ['name',
        'contextItemName',
        'parentItemName',
        'extendedItemName',
        'properties',
        'tags',
        'type'
    ];

    for (var field in item) {
        if (!_.contains(fieldWhitelist, field)) {
            delete item[field];
        }
    }

    //Remote items remove the [] from the extended items name,
    // so we will remove the local ones to match
    if (item.extendedItemName) {
        //As the remote item has removed its brackets we will follow :(
        //TODO: Raise with CXP team
        item.extendedItemName = item.extendedItemName.replace(/\[|\]/g, '');
        //if (item.contextItemName !== '[BBHOST]' && item.tags) {
        if (item.tags) {
            //TODO: Check tags inheritance and raise with CXP team
            //As the remote item is showing inherited tags, with no way if knowing if
            // these are owned or inherited we will assume extended items can't
            // own tags and remove them
            delete item.tags;
        }
    }

    if (item.tags && item.tags.tag) {
        if (item.tags.tag.length > 0) {
            _.forEach(item.tags.tag, function (tag) {
                //Remote items in 5.6 have blacklist set to false by default
                //if (!tag.$blacklist) {
                //tag['$blacklist'] = 'false';
                //}
                delete tag.$manageable;
            });
        } else {
            delete item.tags;
        }
    } else if (item.tags) {
        delete item.tags;
    }

    if (item.properties && item.properties.property) {
        if (item.properties.property.length > 0) {
            var removeInheritedProperties = {};

            _.forEach(item.properties.property, function (property) {
                //TODO: templates don't return $itemName attr, another small inconsistency
                if ((property.$itemName && property.$itemName === item.name) || item.type) {
                    delete property.$readonly;
                    delete property.$manageable;
                    delete property.$itemName;

                    //TODO: property type values are auto generated differently and stored as
                    //      Title case, we will make them all lowercase
                    property.value.$type = property.value.$type.toLowerCase();

                } else if (property.$itemName) {
                    removeInheritedProperties[property.$name] = true;
                }
            });

            //when reading rest remove inherited values so matches local version
            _.remove(item.properties.property, function (value) {
                return removeInheritedProperties[value.$name] ? true : false;
            });
        } else {
            delete item.properties;
        }
    } else if (item.properties) {
        delete item.properties;
    }

    return item;
}

