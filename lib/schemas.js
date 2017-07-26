const {diffArrays, assert, debug, veryDebug} = require('./util')
const {SchemaError} = require('./errors')

exports.validateAndSanitize = function (schema) {
  // validate and sanitize
  assert(schema && typeof schema === 'object', SchemaError, `Must pass a schema object to db.schema(), got ${schema}`)
  assert(schema.version > 0 && typeof schema.version === 'number', SchemaError, `The .version field is required and must be a number, got ${schema.version}`)
  getTableNames(schema).forEach(tableName => {
    var table = schema[tableName]
    if (table === null) {
      return // done, this is a deleted table
    }
    assert(!schema.index || typeof schema.index === 'string' || isArrayOfStrings(schema.index), SchemaError, `The .index field must be a string or an array of strings, got ${schema.index}`)
    table.index = arrayify(table.index)
  })
}

// returns {add:[], change: [], remove: [], tablesToRebuild: []}
// - `add` is an array of [name, tableDef]s
// - `change` is an array of [name, tableChanges]s
// - `remove` is an array of names
// - `tablesToRebuild` is an array of names- tables that will need to be cleared and re-ingested
// - applied using `applyDiff()`, below
exports.diff = function (oldSchema, newSchema) {
  if (!oldSchema) {
    debug(`creating diff for first version`)
  } else {
    debug(`diffing ${oldSchema.version} against ${newSchema.version}`)
  }
  veryDebug('diff old', oldSchema)
  veryDebug('diff new', newSchema)
  // compare tables in both schemas
  // and produce a set of changes which will modify the db
  // to match `newSchema`
  var diff = {add: [], change: [], remove: [], tablesToRebuild: []}
  var allTableNames = new Set(getTableNames(oldSchema).concat(getTableNames(newSchema)))
  for (let tableName of allTableNames) {
    var oldSchemaHasTable = oldSchema ? (tableName in oldSchema) : false
    var newSchemaHasTable = (newSchema[tableName] !== null)
    if (oldSchemaHasTable && !newSchemaHasTable) {
      // remove
      diff.remove.push(tableName)
    } else if (!oldSchemaHasTable && newSchemaHasTable) {
      // add
      diff.add.push([tableName, newSchema[tableName]])
      diff.tablesToRebuild.push(tableName)
    } else if (newSchema[tableName]) {
      // different?
      var tableChanges = diffTables(oldSchema[tableName], newSchema[tableName])
      if (tableChanges.indexDiff) {
        diff.change.push([tableName, tableChanges])
      }
      if (tableChanges.needsRebuild) {
        diff.tablesToRebuild.push(tableName)
      }
    }
  }
  veryDebug('diff result, add', diff.add, 'change', diff.change, 'remove', diff.remove, 'rebuilds', diff.tablesToRebuild)
  return diff
}

// takes the return value of .diff()
// updates `db`
exports.applyDiff = function (db, upgradeTransaction, diff) {
  debug('applying diff')
  veryDebug('diff', diff)
  const tx = upgradeTransaction
  diff.remove.forEach(tableName => {
    // deleted tables
    tx.db.deleteObjectStore(tableName)
  })
  diff.add.forEach(([tableName, tableDef]) => {
    // added tables
    const tableStore = tx.db.createObjectStore(tableName, 'url')
    tableDef.index.forEach(index => addIndex(tableStore, index))
  })
  diff.change.forEach(([tableName, tableChanges]) => {
    // updated tables
    const tableStore = tx.objectStore(tableName)
    tableChanges.indexDiff.remove.forEach(index => removeIndex(tableStore, index))
    tableChanges.indexDiff.add.forEach(index => addIndex(tableStore, index))
  })
}

// add table defs to the db object
exports.addTables = function (db) {
  const tableNames = getActiveTableNames(db)
  debug('adding tables', tableNames)
  tableNames.forEach(tableName => {
    if (db.schemas[tableName] === null) {
      return // deleted table
    }
    db[tableName] = true // TODO
  })
}

// remove table defs from the db object
exports.removeTables = function (db) {
  const tableNames = getActiveTableNames(db)
  debug('removing tables', tableNames)
  tableNames.forEach(tableName => {
    delete db[tableName]
  })
}

// helpers
// =

function diffTables (oldTableDef, newTableDef) {
  return {
    indexDiff: newTableDef.index ? diffArrays(oldTableDef.index, newTableDef.index) : false,
    // need to rebuild the entire DB if the ingest path changes
    needsRebuild: (newTableDef.path && oldTableDef.path !== newTableDef.path)
  }
}

function addIndex (tableStore, index) {
  var multiEntry = false
  var keyPath = index.split('+')
  if (keyPath.length > 1) {
    // compound index
    multiEntry = true
  } else {
    // simple index
    keyPath = keyPath[0]
  }
  tableStore.createIndex(index, keyPath, { multiEntry })
}

function removeIndex (tableStore, index) {
  tableStore.deleteIndex(index)
}

function getTableNames (schema, fn) {
  if (!schema) {
    return []
  }
  // all keys except 'version'
  return Object.keys(schema).filter(k => k !== 'version')
}

function getActiveTableNames (db) {
  var tableNames = new Set()
  db.schemas.forEach(schema => {
    getTableNames(schema).forEach(tableName => {
      if (schema[tableName] === null) {
        tableNames.delete(tableName)
      } else {
        tableNames.add(tableName)
      }
    })
  })
  return Array.from(tableNames)
}

function arrayify (v) {
  return Array.isArray(v) ? v : [v]
}

function isArrayOfStrings (v) {
  return Array.isArray(v) && v.reduce((acc, v) => acc && typeof v === 'string', true)
}