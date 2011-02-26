let EXPORTED_SYMBOLS = ['StorageConnection', 'StorageStatement'];

const Cc = Components.classes;
const Ci = Components.interfaces;

function StorageConnection(aDatabaseFile) {
    this._nativeConnection = Cc['@mozilla.org/storage/service;1']
                             .getService(Ci.mozIStorageService)
                             .openUnsharedDatabase(aDatabaseFile);
    this._writingStatementsQueue = new WritingStatementsQueue(this);
    this._transactionStatements = [];
}

StorageConnection.prototype = {

    get connectionReady()       this._nativeConnection.connectionReady,
    get transactionInProgress() this._nativeConnection.transactionInProgress,
    get lastError()             this._nativeConnection.lastError,

    get schemaVersion()         this._nativeConnection.schemaVersion,
    set schemaVersion(aVersion) this._nativeConnection.schemaVersion = aVersion,


    close: function() {
        return this._nativeConnection.close()
    },

    runTransaction: function(aFunction, aThisObject, aOnError) {
        this._nativeConnection.beginTransaction();
        try {
            aFunction.call(aThisObject);
        }
        catch (ex) {
            if (aOnError)
                aOnError();
            else
                throw ex;
        }
        finally {
            this._transactionStatements.forEach(function(stmt) stmt.reset());
            this._transactionStatements = [];

            // XXX this prevents custom error handler from rolling back the transaction.
            this._nativeConnection.commitTransaction();
        }
    },

    executeSQL: function(aSQLStatements) {
        let statements = Array.isArray(aSQLStatements) ? aSQLStatements : [aSQLStatements];

        statements.forEach(function(stm) {
            try {
                this._nativeConnection.executeSimpleSQL(stm);
            }
            catch (ex) {
                this.reportDatabaseError('SQL statement:\n' + stm);
                throw ex;
            }
        }, this)
    },

    /**
     * Creates a new StorageStatement for this connection.
     *
     * @param aStatement
     *        SQL statement string.
     * @param aDefaultParams [optional]
     *        Object whose properties are name-value pairs of the default parameters.
     *        Default parameters are the parameters which will be used if no other
     *        parameters are bound.
     */
    createStatement: function(aStatement, aDefaultParams) {
        return new StorageStatement(this, aStatement, aDefaultParams);
    },

    /**
     * Wrapper for mozIStorageConnection.executeAsync().
     *
     * @param aStatements
     *        Array of StorageStatement objects to execute.
     * @param aCallback [optional]
     *        An object implementing any of mozIStorageStatementCallback's methods,
     *        or a single function treated as handleCompletion() method.
     */
    executeAsync: function Connection_executeAsync(aStatements, aCallback) {
        aStatements.forEach(function(statement) {
            statement._bindParams();
        })
        let callback = new StatementCallback(aStatements, aCallback);
        this._writingStatementsQueue.add(aStatements, callback);
    },

    createFunction: function(aFunctionName, aNumArguments, aFunction) {
        return this._nativeConnection.createFunction(aFunctionName, aNumArguments, aFunction);
    },

    reportDatabaseError: function(aMessage, aError) {
        let message = aMessage ? aMessage + '\n' : '';
        message += aError ? aError.message : this._nativeConnection.lastErrorString;
        Components.utils.reportError(message);
    }

}


function StorageStatement(aConnection, aStatement, aDefaultParams) {
    // Copy constructor.
    if (aStatement instanceof StorageStatement) {
        this._nativeStatement = aStatement._nativeStatement.clone();
        this._connection = aStatement._connection;
        this._defaultParams = aStatement._defaultParams;
        this._isWritingStatement = aStatement._isWritingStatement;
    }
    // New statement from an SQL string.
    else {
        this._connection = aConnection;

        try {
            this._nativeStatement = aConnection._nativeConnection.createStatement(aStatement);
        }
        catch (ex) {
            this._connection.reportDatabaseError('Statement:\n' + aStatement);
            throw ex;
        }

        this._defaultParams = aDefaultParams || null;
        this._isWritingStatement = !/^\s*SELECT/.test(aStatement);
    }

    this.paramSets = [];
    this.params = {};
}

StorageStatement.prototype = {

    execute: function(aParams) {
        if (aParams)
            this.params = aParams;

        this._bindParams();
        this._nativeStatement.execute();
    },

    executeAsync: function Statement_executeAsync(aCallback) {
        this._bindParams();
        let callback = new StatementCallback(this, aCallback);
        if (this._isWritingStatement)
            this._connection._writingStatementsQueue.add(this, callback);
        else
            this._nativeStatement.executeAsync(callback);
    },

    _bindParams: function() {
        for (let column in this._defaultParams)
            this._nativeStatement.params[column] = this._defaultParams[column];

        if (!this.paramSets.length) {
            for (let column in this.params)
                this._nativeStatement.params[column] = this.params[column];
        }
        else {
            let bindingParamsArray = this._nativeStatement.newBindingParamsArray();

            for (let i = 0; i < this.paramSets.length; i++) {
                let set = this.paramSets[i];
                let bp = bindingParamsArray.newBindingParams();
                for (let column in set)
                    bp.bindByName(column, set[column])
                bindingParamsArray.addParams(bp);
            }

            this._nativeStatement.bindParameters(bindingParamsArray);
        }

        this.paramSets = [];
        this.params = {};
    },

    /**
     * Returns a generator for the results.
     *
     * Note: the generator catches database errors when stepping the statement and resets
     * the statement when they occur, so the consumer doesn't have to wrap everything
     * in try...finally (as long it itself avoids doing anything that risks exceptions).
     */
    get results() {
        if (!this._resultsGenerator)
            this._resultsGenerator = this._createResultGenerator();

        return this._resultsGenerator;
    },

    _createResultGenerator: function() {
        this._bindParams();

        // Avoid property lookup for better performance.
        let nativeStatement = this._nativeStatement;
        let columnCount = nativeStatement.columnCount;

        let columns = [];
        for (let i = 0; i < columnCount; i++)
            columns.push(nativeStatement.getColumnName(i));

        if (this._connection.transactionInProgress)
            this._connection._transactionStatements.push(this);

        try {
            while (nativeStatement.step()) {
                // Copy row's properties to make them enumerable.
                // This may not be worth the performance cost...
                let row = {};
                for (let i = 0; i < columnCount; i++)
                    row[columns[i]] = nativeStatement.row[columns[i]];
                yield row;
            }
        }
        finally {
            nativeStatement.reset();
            this._resultsGenerator = null;
        }
    },

    getSingleResult: function() {
        let row = this.results.next();
        this.reset()

        return row;
    },

    reset: function() {
        this.paramSets = [];
        this.params = {};
        this.results.close();
    },

    clone: function() {
        return new StorageStatement(null, this);
    }

}


function StatementCallback(aStatements, aCallback) {
    let statements = Array.isArray(aStatements) ? aStatements : [aStatements];

    let selects = statements.filter(function(s) !s._isWritingStatement);
    if (selects.length == 1)
        this._selectStatement = selects[0];
    else if (selects.length > 1)
        throw 'mozIStorageStatementCallback is not designed to handle more than one SELECT.';

    if (typeof aCallback == 'function')
        this._callback = { handleCompletion: aCallback };
    else
        this._callback = aCallback || {};
}

StatementCallback.prototype = {

    _selectStatement: null,

    handleResult: function(aResultSet) {
        if (!this._callback.handleResult)
            return;

        let generator = this._getResultsGenerator(aResultSet);
        this._callback.handleResult(generator);
        generator.close();
    },

    handleCompletion: function(aReason) {
        if (this._callback.handleCompletion)
            this._callback.handleCompletion(aReason);
    },

    handleError: function(aError) {
        if (this._callback.handleError)
            this._callback.handleError(aError);
        else
            this._connection.reportDatabaseError(aError);
    },

    _getResultsGenerator: function(aResultSet) {
        let nativeStatement = this._selectStatement._nativeStatement;
        let columnCount = nativeStatement.columnCount;

        let columns = [];
        for (let i = 0; i < columnCount; i++)
            columns.push(nativeStatement.getColumnName(i));

        let row = aResultSet.getNextRow();
        while (row) {
            let obj = {};
            for (let i = 0; i < columnCount; i++)
                obj[columns[i]] = row.getResultByName(columns[i]);
            yield obj;
            row = aResultSet.getNextRow();
        }
    }
}


/**
 * Callbacks notified by writing statements often need to query the database to update
 * views and such, and they rely on the database not to be modified again until they
 * complete. If another writing statement was executed in the background thread before
 * the oberver completed, it would create a race condition.
 *
 * Therefore, we maintain a queue of writing statements to prevent any such statement
 * from being executed until the callback of the previous one has completed.
 */
function WritingStatementsQueue(aConnection) {
    this._connection = aConnection;
    this._queue = [];
}

WritingStatementsQueue.prototype = {

    _executing: false,

    add: function add(aStatements, aCallback) {
        this._queue.push({
            statements: Array.isArray(aStatements) ? aStatements : [aStatements],
            callback: aCallback
        });

        if (!this._executing)
            this._executeNext();
    },

    _onStatementCompleted: function() {
        this._queue.shift();
        this._executing = false;
        if (this._queue.length)
            this._executeNext();
    },

    _executeNext: function() {
        let statements = this._queue[0].statements;
        let callback = this._queue[0].callback;
        let handleCompletion = callback.handleCompletion;

        callback.handleCompletion = function(aReason) {
            try {
                if (handleCompletion)
                    handleCompletion.call(callback, aReason);
            }
            finally {
                this._onStatementCompleted();
            }
        }.bind(this);

        let nativeStatements = statements.map(function(s) s._nativeStatement);

        if (nativeStatements.length > 1) {
            let nativeConnection = this._connection._nativeConnection;
            nativeConnection.executeAsync(nativeStatements, nativeStatements.length,
                                          callback);
        }
        else {
            nativeStatements[0].executeAsync(callback);
        }

        this._executing = true;
    }

}


function log(aMessage) {
    let consoleService = Cc['@mozilla.org/consoleservice;1']
                         .getService(Ci.nsIConsoleService);
    consoleService.logStringMessage(aMessage);
}
