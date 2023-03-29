var util = require('util'),
    Base = require('mocha').reporters.Base;

function AppVeyorReporter(runner, options) {
  Base.call(this, runner);

  this.options = (options && options.reporterOptions) || {};

  // Default options
  this.options.appveyorApiUrl = process.env.APPVEYOR_API_URL || this.options.appveyorApiUrl;
  this.options.appveyorBatchSize = process.env.APPVEYOR_BATCH_SIZE || this.options.appveyorBatchSize || 100;
  this.options.appveyorBatchIntervalInMs = process.env.APPVEYOR_BATCH_INTERVAL_IN_MS || this.options.appveyorBatchIntervalInMs || 1000;

  var got = require('got'),
    log = console.log.bind(console),
    error = console.error.bind(console),
    warn = console.warn.bind(console),
    logEntries = [],
    self = this;

  if(!this.options.appveyorApiUrl) {
    warn("appveyorApiUrl option and APPVEYOR_API_URL environment variable not set, will not report to AppVeyor.");
  }

  // Client to be used to make API calls.
  this.client = this.options.appveyorApiUrl ? got.default.extend({
    prefixUrl: this.options.appveyorApiUrl
  }) : undefined;
  // Callback to be invoked (if defined) when an in flight request is completed.
  this.doneCb = undefined;
  // Whether or not API call is in flight.
  this.inFlight = false;
  // Enqueued tests.
  this.testQueue = [];
  // Timeout configured to make next API call.
  this.sendTimeout = undefined;

  /**
   * Adds test to queue of tests to be sent with next API call.
   *
   * May also trigger pending tests to be sent.
   *
   * @param test test to send.
   */
  var addTest = function(test) {
    if(!self.client) {
      return;
    }
    self.testQueue.push(test);
    self.maybeSendTests();
  };

  /**
   * Takes a test result and maps it to the output format that AppVeyor accepts.
   * @param test Result generated by mocha.
   * @returns {{testName: string, testFramework: string, fileName: string, outcome: string, durationMilliseconds: Number, StdOut: string, StdErr: string}}
   */
  var mapTest = function(test) {
    var stdout = "";
    var stderr = "";
    logEntries.forEach(function (data) {
      var msg = util.format.apply(util, data.msg);
      if (data.type === 'out') {
        stdout = stdout + msg + '\n';
      } else {
        stderr = stderr + msg + '\n';
      }
    });
    return {
      testName: test.fullTitle(),
      testFramework: 'Mocha',
      fileName: test.file,
      outcome: test.state === "passed" ? "Passed" : null,
      durationMilliseconds: test.duration,
      StdOut: stdout,
      StdErr: stderr
    };
  };

  /**
   * @param type {String} The type of message being logged (either 'out' for stdout or anything else for stderr).
   * @param original {Function} Function to be wrapped.
   * @returns {Function} A function that wraps the given original function with behavior that records messages to
   * a separate array.
   */
  var handleConsole = function(type, original) {
    return function() {
      var args = Array.prototype.slice.call(arguments);
      if(original.apply && typeof original.apply === 'function') {
        original.apply(original, arguments);
      }
      logEntries.push({ type: type, msg: args });
    }
  };

  runner.on('test', function () {
    // trap console so we can record stdout/stderr to appveyor.
    logEntries = [];
    console.log = handleConsole("out", log);
    console.warn = handleConsole("warn", warn);
    console.error = handleConsole("err", error);
  });

  runner.on('test end', function() {
    // reset console implementations to original implementation.
    console.log = log;
    console.warn = warn;
    console.error = error;
  });

  runner.on('pass', function(mochaTest){
    var test = mapTest(mochaTest);
    addTest(test);
  });

  runner.on('pending', function(mochaTest) {
    var test = mapTest(mochaTest);
    test.outcome = 'Ignored';
    addTest(test);
  });

  runner.on('fail', function(mochaTest, err) {
    var test = mapTest(mochaTest);
    test.outcome = 'Failed';
    test.ErrorMessage = err.message;
    test.ErrorStackTrace = err.stack;
    addTest(test);
  });

  // Schedule tests to be sent initially.
  self.scheduleTests();
}

util.inherits(AppVeyorReporter, Base);

/**
 * Schedule tests to be sent after appveyorBatchIntervalInMs.
 */
AppVeyorReporter.prototype.scheduleTests = function() {
  this.sendTimeout = setTimeout(this.sendTests.bind(this), this.options.appveyorBatchIntervalInMs);
};

/**
 * Trigger tests to be sent.
 */
AppVeyorReporter.prototype.sendTests = function() {
  var self = this;

  // Don't send tests if endpoint not set up.
  if(!self.client) {
    return;
  }

  // clear existing timeout.
  if(self.sendTimeout) {
    clearTimeout(self.sendTimeout);
    self.sendTimeout = undefined;
  }

  // if queue is empty, schedule tests to be submitted later, but only if not done.
  if(self.testQueue.length === 0) {
    if (!self.doneCb) {
      self.scheduleTests();
    }
  } else {
    self.inFlight = true;
    var data = this.testQueue.slice();
    self.testQueue = [];
    self.client.post('api/tests/batch', {
      json: data,
    }).then((response) => {
      self.inFlight = false;
      // if doneCb set, and test queue is empty, invoke doneCb, otherwise if not empty, send tests immediately.
      if (self.doneCb) {
        if (self.testQueue.length === 0) {
          self.doneCb();
          self.doneCb = undefined;
        } else {
          self.sendTests();
        }
      } else {
        // If tests weren't ready to be sent, schedule.
        if (!self.maybeSendTests()) {
          self.scheduleTests();
        }
      }
    }).catch((err) => {
      self.inFlight = false;
      console.error("Error returned from posting test result to AppVeyor. Error: %s. \n.", err);
    });
  }
};

/**
 * Trigger enqueued tests to be sent to appveyor if at least appveyorBatchSize tests are enqueued and there is no API
 * @returns {boolean}
 */
AppVeyorReporter.prototype.maybeSendTests = function() {
  // if more than appveyor_batch_size tests are enqueued, send them.
  if(!this.inFlight && this.testQueue.length >= this.options.appveyorBatchSize) {
    this.sendTests();
    return true;
  } else {
    return false;
  }
};

/**
 * Override done to await any in flight HTTP requests to post tests to AppVeyor.
 *
 * @param failures
 * @param {Function} fn
 */
AppVeyorReporter.prototype.done = function (failures, fn) {
  // register doneCb to be invoked when API call finishes.
  var invoked = false;
  this.doneCb = function() {
    invoked = true;
    fn(failures);
  };

  // If no API call in flight and there are pending tests, send them.
  if(!this.inFlight && this.testQueue.length > 0) {
    this.sendTests();
  }

  // If no API call is in flight and the callback hasn't been invoked yet, invoke it here.
  if(!this.inFlight && !invoked) {
    fn(failures);
  }
};


module.exports = AppVeyorReporter;
