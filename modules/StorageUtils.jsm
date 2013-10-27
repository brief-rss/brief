const EXPORTED_SYMBOLS = ['StorageConnection', 'StorageStatement', 'StorageError'];

Components.utils.import('resource://brief/common.jsm');
Components.utils.import('resource://gre/modules/Services.jsm');
Components.utils.import('resource://gre/modules/commonjs/sdk/core/promise.js');
Components.utils.import('resource://gre/modules/Task.jsm');

IMPORT_COMMON(this);


/**
 * Wrapper object for mozIStorageConnection.
 *
 * @param aDatabaseFile
 *        nsIFile of the database file.
 * @param aSharedCache
 *        Whether to use shared cache. Default TRUE.
 */
function StorageConnection(aDatabaseFile, aSharedCache) {
    let sharedCache = aSharedCache === undefined ? true : false;

    if (sharedCache)
        this._nativeConnection = Services.storage.openDatabase(aDatabaseFile);
    else
        this._nativeConnection = Services.storage.openUnsharedDatabase(aDatabaseFile);

    this._writingStatementsQueue = new WritingStatementsQueue(this);
    this._transactionStatements = [];
}

StorageConnection.prototype = {

    get connectionReady()       this._nativeConnection.connectionReady,
    get transactionInProgress() this._nativeConnection.transactionInProgress,
    get lastError()             this._nativeConnection.lastError,
    get lastErrorString()       this._nativeConnection.lastErrorString,

    get schemaVersion()         this._nativeConnection.schemaVersion,
    set schemaVersion(aVersion) this._nativeConnection.schemaVersion = aVersion,


    close: function() {
        return this._nativeConnection.close()
    },

    /**
     * Begins a transaction, runs the given function, and commits the transaction.
     * If an exception is thrown within the given function, the transaction is
     * rolled back and all the active statements are rest.
     *
     * @param aFunction
     *        Function to run in the transaction.
     * @oaran aOnError [optional]
     *        Function to be called in case of an error.
     */
    runTransaction: function Connection_runTransaction(aFunction, aOnError) {
        this._nativeConnection.beginTransaction();
        try {
            aFunction();
            this._nativeConnection.commitTransaction();
        }
        catch (ex) {
            this._nativeConnection.rollbackTransaction();
            if (aOnError)
                aOnError();
            else
                throw ex;
        }
        finally {
            for (let statement of this._transactionStatements)
                statement.reset();
            this._transactionStatements = [];
        }
    },

    /**
     * Takes one or more SQL strings as arguments and executes them as separate statements.
     * Alternatively, you can pass a single argument of an array of strings.
     */
    executeSQL: function Connection_executeSQL() {
        let statements = Array.isArray(arguments[0]) ? arguments[0] : arguments;

        for (let i = 0; i < statements.length; i++) {
            let sql = statements[i];
            try {
                this._nativeConnection.executeSimpleSQL(sql);
            }
            catch (ex) {
                throw new StorageError('Error when executing simple SQL:\n' + sql,
                                       this.lastErrorString);
            }
        }
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
    createStatement: function Connection_createStatement(aStatement, aDefaultParams) {
        return new StorageStatement(this, aStatement, aDefaultParams);
    },

    /**
     * Wrapper for mozIStorageConnection.executeAsync().
     *
     * @param aStatements
     *        Array of StorageStatement objects to execute.
     * @param aResultHandler <function> [optional]
     *        Function called for each selected row.
     * @returns Promise<integer> The reason the statement completed (see constants in
     *          mozIStorageStatementCallback), or rejected with a StorageError.
     */
    executeAsync: function Connection_executeAsync(aStatements, aResultHandler) {
        if (!aStatements || !aStatements.length)
            throw new Error('No statements to execute');

        for (let statement of aStatements)
            statement._bindParams();

        let callback = new StatementCallback(aStatements, aResultHandler);
        this._writingStatementsQueue.add(aStatements, callback);

        return callback.promise;
    },

    createFunction: function Connection_createFunction(aName, aNumArguments, aFunction) {
        return this._nativeConnection.createFunction(aName, aNumArguments, aFunction);
    }

}


/**
 * Wrapper object for mozIStorageStatement.
 *
 * @param aConnection
 *        StorageConnection to create a statement for.
 * @param aSQLString
 *        SQL string of the statement, or another StorageStatement object to clone.
 * @param aDefaultParams [optional]
 *        Object whose properties are name-value pairs of the default parameters.
 *        Default parameters are the parameters which will be used if no other
 *        parameters are bound.
 */
function StorageStatement(aConnection, aSQLString, aDefaultParams) {
    this.connection = aConnection;
    this.sqlString = aSQLString;
    this.isWritingStatement = !/^\s*SELECT/.test(aSQLString);

    try {
        this._nativeStatement = aConnection._nativeConnection.createStatement(aSQLString);
    }
    catch (ex) {
        throw new StorageError('Error when creating statement', aConnection.lastErrorString, this);
    }

    /**
     * Object whose properties are name-value pairs of the default parameters.
     * Default parameters are the parameters which will be used if no other
     * parameters are bound.
     */
    this.defaultParams = aDefaultParams || {};
    Object.freeze(this.defaultParams);

    // Fill in empty params so that consumers can enumerate them.
    this.__params = {};
    for (let paramName in this._nativeStatement.params)
        this.__params[paramName] = undefined;
    Object.seal(this.__params);
    Object.preventExtensions(this.__params);

    /**
     * Array of objects whose properties are name-value pairs of parameters.
     */
    this.paramSets = [];
}

StorageStatement.prototype = {

    /**
     * Object whose properties are name-value pairs of parameters.
     */
    get params() {
        return this.__params;
    },
    set params(aValue) {
        for (let paramName in this.__params)
            this.__params[paramName] = aValue[paramName];

        return this.__params;
    },

    /**
     * Synchronously executes the statement with the bound parameters.
     * Parameters passed directly to this function are favored over
     * the ones bound in the params property.
     *
     * @param aParams [optional]
     *        Object whose properties are name-value pairs of parameters to bind.
     */
    execute: function Statement_execute(aParams) {
        if (aParams)
            this.params = aParams;

        this._bindParams();
        this._nativeStatement.execute();
    },

    /**
     * Asynchronously executes the statement with the bound parameters.
     * Parameters bound in the paramSets array are favored over the ones
     * in the params property.
     *
     * @param aResultHandler <function> [optional]
     *        Function called for each selected row.
     * @returns Promise<integer> The reason the statement completed (see constants in
     *          mozIStorageStatementCallback), or rejected with a StorageError.
     */
    executeAsync: function Statement_executeAsync(aResultHandler) {
        this._bindParams();

        let callback = new StatementCallback(this, aResultHandler);

        if (this.isWritingStatement)
            this.connection._writingStatementsQueue.add(this, callback);
        else
            this._nativeStatement.executeAsync(callback);

        return callback.promise;
    },

    /**
     * Returns a generator for the results. The statement is automatically reset
     * after all rows are iterated, otherwise it must be reset manually.
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

    /**
     * Returns the first row of the results and resets the statement.
     */
    getSingleResult: function Statement_getSingleResult() {
        let row = this.results.next();
        this.reset()

        return row;
    },

    /**
     * Asynchronously executes the statement and collects the result rows
     * into an array. To be used only with SELECT statements.
     *
     * @returns Promise<array> Resulting rows, or rejected with a StorageError.
     */
    getResultsAsync: function Statement_getResultsAsync() {
        let deferred = Promise.defer();

        if (this.isWritingStatement)
            throw new Error('StorageStatement.getResultsAsync() can be used only with SELECT statements');

        this._bindParams();

        let rowArray = [];

        // Avoid repeated XPCOM calls for performance.
        let columnCount = this._nativeStatement.columnCount;

        let columns = [];
        for (let i = 0; i < columnCount; i++)
            columns.push(this._nativeStatement.getColumnName(i));

        this._nativeStatement.executeAsync({
            handleResult: aResultSet => {
                let row = aResultSet.getNextRow();
                while (row) {
                    let obj = {};

                    // This is performance-critical so don't use for...of sugar.
                    for (let i = 0; i < columnCount; i++)
                        obj[columns[i]] = row.getResultByName(columns[i]);

                    rowArray.push(obj);
                    row = aResultSet.getNextRow();
                }
            },
            handleCompletion: reason => deferred.resolve(rowArray),
            handleError: error => {
                deferred.reject(new StorageError('Error when executing statement',
                                error.message, this));
            }
        })

        return deferred.promise;
    },

    /**
     * Unbinds parameters and resets the statement.
     */
    reset: function Statement_reset() {
        this.paramSets = [];
        this.params = {};

        if (this._resultsGenerator)
            this._resultsGenerator.close();
    },

    _bindParams: function Statement__bindParams() {
        if (!this.paramSets.length) {

            // For undefined parameters, use the default params.
            for (let paramName in this.params) {
                if (this.params[paramName] === undefined) {
                    if (this.defaultParams[paramName] !== undefined)
                        this.params[paramName] = this.defaultParams[paramName];
                    else
                        throw new Error('Undefined "' + paramName + '" parameter. Statement:\n' + this.sqlString);
                }
            }

            for (let paramName in this.params)
                this._nativeStatement.params[paramName] = this.params[paramName];
        }
        else {
            let bindingParamsArray = this._nativeStatement.newBindingParamsArray();
            for (let set of this.paramSets) {
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

    _createResultGenerator: function Statement__createResultGenerator() {
        this._bindParams();

        // Avoid repeated XPCOM calls for performance.
        let columnCount = this._nativeStatement.columnCount;
        let columns = [];

        // This is performance-critical so don't use for...of sugar.
        for (let i = 0; i < columnCount; i++)
            columns.push(this._nativeStatement.getColumnName(i));

        if (this.connection.transactionInProgress)
            this.connection._transactionStatements.push(this);

        try {
            while (this._nativeStatement.step()) {
                // Copy row's properties to make them enumerable.
                // This may be a significant performance hit...
                let row = {};
                for (let i = 0; i < columnCount; i++)
                    row[columns[i]] = this._nativeStatement.row[columns[i]];
                yield row;
            }
        }
        finally {
            this._nativeStatement.reset();
            this._resultsGenerator = null;
        }
    },

    clone: function Statement_clone() {
        let statement = new StorageStatement(this.connection, this.sqlString,
                                             this.defaultParams);
        return statement;
    }

}

/**
 * Wrapper object for mozIStorageStatementCallback.
 *
 * @param aStatements
 *        One or more StorageStatement's for which to create a callback.
 * @param aResultHandler [optional]
 *        Function called for each selected row.
 */
function StatementCallback(aStatements, aResultHandler) {
    this._statements = Array.isArray(aStatements) ? aStatements : [aStatements];

    let selects = this._statements.filter(function(s) !s.isWritingStatement);
    if (selects.length == 1)
        this._selectStatement = selects[0];
    else if (selects.length > 1)
        throw new Error('mozIStorageStatementCallback cannot handle more than one SELECT');

    this._resultHandler = aResultHandler || null;
    this.connection = this._statements[0].connection;
    this._deferred = Promise.defer();
}

StatementCallback.prototype = {

    // Promise that will be resolved when the statement completes or rejected
    // with a StorrageError.
    get promise() this._deferred.promise,

    _deferred: null,

    _selectStatement: null,

    handleResult: function StatementCallback_handleResult(aResultSet) {
        if (!this._resultHandler)
            return;

        let nativeStatement = this._selectStatement._nativeStatement;
        let columnCount = nativeStatement.columnCount;

        if (!this.columns) {
            this.columns = [];
            for (let i = 0; i < columnCount; i++)
                this.columns.push(nativeStatement.getColumnName(i));
        }

        let columns = this.columns;

        let row = aResultSet.getNextRow();
        while (row) {
            // This is performance-critical so don't use for...of sugar.
            let obj = {};
            for (let i = 0; i < columnCount; i++)
                obj[columns[i]] = row.getResultByName(columns[i]);

            this._resultHandler(obj);

            row = aResultSet.getNextRow();
        }
    },

    handleCompletion: function StatementCallback_handleCompletion(aReason) {
        if (aReason == Ci.mozIStorageStatementCallback.REASON_FINISHED)
            this._deferred.resolve(aReason);
    },

    handleError: function StatementCallback_handleError(aError) {
        let statement = this._statements.length == 1 ? this._statements[0] : null;
        let error = new StorageError('Error when executing statement', aError.message, statement);
        this._deferred.reject(error);
    }
}


/**
 * Callbacks notified by writing statements often need to query the database to update
 * views. They rely on the database not being modified again until they complete.
 * If another writing statement was executed in the background thread before the
 * oberver completed, it would create a race condition potentially screwing up
 * the observer.
 *
 * Hence, we maintain a queue of writing statements to prevent any such statement
 * from being executed until the callback of the previous one has completed.
 */
function WritingStatementsQueue(aConnection) {
    this._connection = aConnection;
    this._queue = [];
}

WritingStatementsQueue.prototype = {

    _executing: false,

    add: function WritingStatementsQueue_add(aStatements, aCallback) {
        this._queue.push({
            statements: Array.isArray(aStatements) ? aStatements : [aStatements],
            callback: aCallback
        });

        if (!this._executing)
            this._executeNext();
    },

    _onStatementCompleted: function WritingStatementsQueue__onStatementCompleted() {
        this._queue.shift();
        this._executing = false;
        if (this._queue.length)
            this._executeNext();
    },

    _executeNext: function WritingStatementsQueue__executeNext() {
        let statements = this._queue[0].statements;
        let callback = this._queue[0].callback;
        let handleCompletion = callback.handleCompletion;

        callback.handleCompletion = reason => {
            try {
                if (handleCompletion)
                    handleCompletion.call(callback, reason);
            }
            finally {
                this._onStatementCompleted();
            }
        }

        let nativeStatements = [stmt._nativeStatement for (stmt of statements)];

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

function StorageError(aCustomMessage, aErrorString, aStatement) {
    let message = aCustomMessage ? aCustomMessage + '\n' : 'Brief database error';

    if (aErrorString)
        message += aErrorString + '\n';

    if (aStatement)
        message += 'SQL statement\n' + aStatement.sqlString;

    return new Error(message);
}
