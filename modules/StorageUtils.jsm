const EXPORTED_SYMBOLS = ['StorageConnection', 'StorageStatement', 'StorageAsyncStatement'];

Components.utils.import('resource://brief/common.jsm');
Components.utils.import('resource://gre/modules/Services.jsm');

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
            for (let statement in this._transactionStatements)
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
                this.reportDatabaseError(null, 'SQL statement:\n' + sql);
                throw ex;
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
     * Creates a new StorageAsyncStatement for this connection.
     *
     * @see StorageConnection.createStatement().
     */
    createAsyncStatement: function Connection_createAsyncStatement(aStatement, aDefaultParams) {
        return new StorageAsyncStatement(this, aStatement, aDefaultParams);
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
        if (!aStatements || !aStatements.length)
            throw new Error('No statements to execute');

        for (let statement in aStatements)
            statement._bindParams();

        let callback = new StatementCallback(aStatements, aCallback);
        this._writingStatementsQueue.add(aStatements, callback);
    },

    createFunction: function Connection_createFunction(aName, aNumArguments, aFunction) {
        return this._nativeConnection.createFunction(aName, aNumArguments, aFunction);
    },

    reportDatabaseError: function Connection_reportDatabaseError(aError, aMessage) {
        let message = aMessage ? aMessage + '\n' : '';
        message += aError ? aError.message : this.lastErrorString;
        Components.utils.reportError(message);
    }

}


/**
 * Wrapper object for mozIStorageAsyncStatement.
 *
 * See StorageStatement for description of parameters.
 */
function StorageAsyncStatement(aConnection, aStatement, aDefaultParams) {
    this._init(aConnection, aStatement, aDefaultParams);

    if (typeof aStatement == 'string')
        this._nativeStatement = aConnection._nativeConnection.createAsyncStatement(aStatement);
}

StorageAsyncStatement.prototype = {

    /**
     * Object whose properties are name-value pairs of parameters
     */
    params: {},

    /**
     * Array of objects whose properties are name-value pairs of parameters.
     */
    paramSets: [],

    /**
     * Asynchronously executes the statement with the bound parameters.
     * Parameters bound in the paramSets array are favored over the ones
     * in the params property.
     *
     * @param aCallback [optional]
     *        An object implementing any of mozIStorageStatementCallback's methods,
     *        or a single function treated as handleCompletion() method.
     */
    executeAsync: function StorageAsyncStatement_executeAsync(aCallback) {
        this._bindParams();
        let callback = new StatementCallback(this, aCallback);
        if (this._isWritingStatement)
            this._connection._writingStatementsQueue.add(this, callback);
        else
            this._nativeStatement.executeAsync(callback);
    },

    /**
     * Asynchronously executes the statement and collects the result rows
     * into an array. To be used only with SELECT statements.
     *
     * @param aCallback
     *        Receives an array of all the results row.
     * @param aOnError [optional]
     *        Function called in case of an error, taking mozIStorageError as argument.
     */
    getResultsAsync: function StorageAsyncStatement_getResultsAsync(aCallback, aOnError) {
        if (this._isWritingStatement)
            throw new Error('StorageStatement.getResultsAsync() can be used only with SELECT statements');

        this._bindParams();

        let rowArray = [];

        // Avoid property lookup for performance.
        let columnCount = this._nativeStatement.columnCount;

        let columns = [];
        for (let i = 0; i < columnCount; i++)
            columns.push(this._nativeStatement.getColumnName(i));

        this._nativeStatement.executeAsync({
            handleResult: function(aResultSet) {
                let row = aResultSet.getNextRow();
                while (row) {
                    let obj = {};
                    for (let i = 0; i < columnCount; i++)
                        obj[columns[i]] = row.getResultByName(columns[i]);
                    rowArray.push(obj);
                    row = aResultSet.getNextRow();
                }
            },
            handleCompletion: function(aReason) {
                aCallback(rowArray);
            },
            handleError: aOnError || this._connection.reportDatabaseError
        })
    },

    clone: function StorageAsyncStatement_clone() {
        return new StorageAsyncStatement(null, this);
    },

    _init: function StorageAsyncStatement__init(aConnection, aStatement, aDefaultParams) {
        // Copy constructor.
        if (aStatement instanceof StorageAsyncStatement) {
            this._nativeStatement = aStatement._nativeStatement.clone();
            this._connection = aStatement._connection;
            this._defaultParams = aStatement._defaultParams;
            this._isWritingStatement = aStatement._isWritingStatement;
            this._sqlString = aStatement._sqlString;
        }
        // New statement from an SQL string.
        else {
            this._connection = aConnection;
            this._defaultParams = aDefaultParams || null;
            this._isWritingStatement = !/^\s*SELECT/.test(aStatement);
            this._sqlString = aStatement;
        }

        this.params = {};
        this.paramSets = [];
    },

    _bindParams: function StorageAsyncStatement__bindParams() {
        for (let column in this._defaultParams)
            this._nativeStatement.params[column] = this._defaultParams[column];

        if (this.paramSets.length) {
            let bindingParamsArray = this._nativeStatement.newBindingParamsArray();
            for (let i = 0; i < this.paramSets.length; i++) {
                let set = this.paramSets[i];
                let bp = bindingParamsArray.newBindingParams();
                for (let column in set)
                    bp.bindByName(column, set[column]);
                bindingParamsArray.addParams(bp);
            }

            this._nativeStatement.bindParameters(bindingParamsArray);
        }
        else {
            for (let column in this.params)
            this._nativeStatement.params[column] = this.params[column];
        }

        this.params = {};
        this.paramSets = [];
    }

}


/**
 * Wrapper object for mozIStorageStatement.
 *
 * @param aConnection
 *        StorageConnection to create a statement for.
 * @param aStatement
 *        SQL string of the statement, or another StorageStatement object to clone.
 * @param aDefaultParams [optional]
 *        Object whose properties are name-value pairs of the default parameters.
 *        Default parameters are the parameters which will be used if no other
 *        parameters are bound.
 */
function StorageStatement(aConnection, aStatement, aDefaultParams) {
    this._init(aConnection, aStatement, aDefaultParams);

    if (typeof aStatement == 'string')
        this._nativeStatement = aConnection._nativeConnection.createStatement(aStatement);
}

StorageStatement.prototype = {

    /**
     * Synchronously executes the statement with the bound parameters.
     * Parameters passed directly to this function are favored over
     * the ones bound in the params property.
     *
     * @param aParams [optional]
     *        Object whose properties are name-value pairs of parameters to bind.
     */
    execute: function StorageStatement_execute(aParams) {
        if (aParams)
            this.params = aParams;

        this._bindParams();
        this._nativeStatement.execute();
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
    getSingleResult: function StorageStatement_getSingleResult() {
        let row = this.results.next();
        this.reset()

        return row;
    },

    /**
     * Unbinds parameters and resets the statement.
     */
    reset: function StorageStatement_reset() {
        this.results.close();
        this.params = {};
        this.paramSets = [];
    },

    clone: function StorageStatement_clone() {
        return new StorageStatement(null, this);
    },

    _createResultGenerator: function StorageStatement__createResultGenerator() {
        this._bindParams();

        // Avoid property lookup for performance.
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
    }

}

extend(StorageStatement, StorageAsyncStatement);


/**
 * Wrapper object for mozIStorageStatementCallback.
 *
 * @param aStatements
 *        One or more StorageStatement's for which to create a callback.
 * @param aCallback [optional]
 *        Object implementing any of the mozIStorageStatementCallback methods.
 */
function StatementCallback(aStatements, aCallback) {
    let statements = Array.isArray(aStatements) ? aStatements : [aStatements];

    let selects = statements.filter(function(s) !s._isWritingStatement);
    if (selects.length == 1)
        this._selectStatement = selects[0];
    else if (selects.length > 1)
        throw new Error('mozIStorageStatementCallback is not designed to handle more than one SELECT');

    if (typeof aCallback == 'function')
        this._callback = { handleCompletion: aCallback };
    else
        this._callback = aCallback || {};

    this._connection = statements[0]._connection;
}

StatementCallback.prototype = {

    _selectStatement: null,

    handleResult: function StatementCallback_handleResult(aResultSet) {
        if (!this._callback.handleResult)
            return;

        // Avoid property look-up for performance.
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
            let obj = {};
            for (let i = 0; i < columnCount; i++)
                obj[columns[i]] = row.getResultByName(columns[i]);
            this._callback.handleResult(obj);
            row = aResultSet.getNextRow();
        }
    },

    handleCompletion: function StatementCallback_handleCompletion(aReason) {
        if (this._callback.handleCompletion)
            this._callback.handleCompletion(aReason);
    },

    handleError: function StatementCallback_handleError(aError) {
        if (this._callback.handleError)
            this._callback.handleError(aError);
        else
            this._connection.reportDatabaseError(aError);
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

        callback.handleCompletion = function(aReason) {
            try {
                if (handleCompletion)
                    handleCompletion.call(callback, aReason);
            }
            finally {
                this._onStatementCompleted();
            }
        }.bind(this);

        let nativeStatements = [stmt._nativeStatement for each (stmt in statements)];

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
