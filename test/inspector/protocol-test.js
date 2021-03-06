// Copyright 2016 the V8 project authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

InspectorTest = {};
InspectorTest._dispatchTable = new Map();
InspectorTest._requestId = 0;
InspectorTest._dumpInspectorProtocolMessages = false;
InspectorTest._eventHandler = {};

Protocol = new Proxy({}, {
  get: function(target, agentName, receiver) {
    return new Proxy({}, {
      get: function(target, methodName, receiver) {
        const eventPattern = /^on(ce)?([A-Z][A-Za-z0-9]+)/;
        var match = eventPattern.exec(methodName);
        if (!match) {
          return (args, contextGroupId) => InspectorTest._sendCommandPromise(`${agentName}.${methodName}`, args || {}, contextGroupId);
        } else {
          var eventName = match[2];
          eventName = eventName.charAt(0).toLowerCase() + eventName.slice(1);
          if (match[1])
            return () => InspectorTest._waitForEventPromise(
                       `${agentName}.${eventName}`);
          else
            return (listener) => { InspectorTest._eventHandler[`${agentName}.${eventName}`] = listener };
        }
      }
    });
  }
});

var utils = {};
(function setupUtils() {
  utils.load = load;
  this.load = null;
  utils.read = read;
  this.read = null;
  utils.compileAndRunWithOrigin = compileAndRunWithOrigin;
  this.compileAndRunWithOrigin = null;
  utils.quit = quit;
  this.quit = null;
  utils.print = print;
  this.print = null;
  utils.setlocale = setlocale;
  this.setlocale = null;
  utils.setCurrentTimeMSForTest = setCurrentTimeMSForTest;
  this.setCurrentTimeMSForTest = null;
  utils.schedulePauseOnNextStatement = schedulePauseOnNextStatement;
  this.schedulePauseOnNextStatement = null;
  utils.cancelPauseOnNextStatement = cancelPauseOnNextStatement;
  this.cancelPauseOnNextStatement = null;
  utils.reconnect = reconnect;
  this.reconnect = null;
  utils.createContextGroup = createContextGroup;
  this.createContextGroup = null;
})();

InspectorTest.log = utils.print.bind(null);

InspectorTest.logMessage = function(originalMessage)
{
  var message = JSON.parse(JSON.stringify(originalMessage));
  if (message.id)
    message.id = "<messageId>";

  const nonStableFields = new Set(["objectId", "scriptId", "exceptionId", "timestamp",
    "executionContextId", "callFrameId", "breakpointId", "bindRemoteObjectFunctionId", "formatterObjectId" ]);
  var objects = [ message ];
  while (objects.length) {
    var object = objects.shift();
    for (var key in object) {
      if (nonStableFields.has(key))
        object[key] = `<${key}>`;
      else if (typeof object[key] === "object")
        objects.push(object[key]);
    }
  }

  InspectorTest.logObject(message);
  return originalMessage;
}

InspectorTest.logObject = function(object, title)
{
  var lines = [];

  function dumpValue(value, prefix, prefixWithName)
  {
    if (typeof value === "object" && value !== null) {
      if (value instanceof Array)
        dumpItems(value, prefix, prefixWithName);
      else
        dumpProperties(value, prefix, prefixWithName);
    } else {
      lines.push(prefixWithName + String(value).replace(/\n/g, " "));
    }
  }

  function dumpProperties(object, prefix, firstLinePrefix)
  {
    prefix = prefix || "";
    firstLinePrefix = firstLinePrefix || prefix;
    lines.push(firstLinePrefix + "{");

    var propertyNames = Object.keys(object);
    propertyNames.sort();
    for (var i = 0; i < propertyNames.length; ++i) {
      var name = propertyNames[i];
      if (!object.hasOwnProperty(name))
        continue;
      var prefixWithName = "    " + prefix + name + " : ";
      dumpValue(object[name], "    " + prefix, prefixWithName);
    }
    lines.push(prefix + "}");
  }

  function dumpItems(object, prefix, firstLinePrefix)
  {
    prefix = prefix || "";
    firstLinePrefix = firstLinePrefix || prefix;
    lines.push(firstLinePrefix + "[");
    for (var i = 0; i < object.length; ++i)
      dumpValue(object[i], "    " + prefix, "    " + prefix + "[" + i + "] : ");
    lines.push(prefix + "]");
  }

  dumpValue(object, "", title || "");
  InspectorTest.log(lines.join("\n"));
}

InspectorTest.logCallFrames = function(callFrames)
{
  for (var frame of callFrames) {
    var functionName = frame.functionName || '(anonymous)';
    var url = frame.url ? frame.url : InspectorTest._scriptMap.get(frame.location.scriptId).url;
    var lineNumber = frame.location ? frame.location.lineNumber : frame.lineNumber;
    var columnNumber = frame.location ? frame.location.columnNumber : frame.columnNumber;
    InspectorTest.log(`${functionName} (${url}:${lineNumber}:${columnNumber})`);
  }
}

InspectorTest.logSourceLocation = function(location)
{
  var scriptId = location.scriptId;
  if (!InspectorTest._scriptMap || !InspectorTest._scriptMap.has(scriptId)) {
    InspectorTest.log("InspectorTest.setupScriptMap should be called before Protocol.Debugger.enable.");
    InspectorTest.completeTest();
  }
  var script = InspectorTest._scriptMap.get(scriptId);
  if (!script.scriptSource) {
    return Protocol.Debugger.getScriptSource({ scriptId })
      .then(message => script.scriptSource = message.result.scriptSource)
      .then(dumpSourceWithLocation);
  }
  return Promise.resolve().then(dumpSourceWithLocation);

  function dumpSourceWithLocation() {
    var lines = script.scriptSource.split('\n');
    var line = lines[location.lineNumber];
    line = line.slice(0, location.columnNumber) + '#' + (line.slice(location.columnNumber) || '');
    lines[location.lineNumber] = line;
    InspectorTest.log(lines.slice(Math.max(location.lineNumber - 1, 0), location.lineNumber + 2).join('\n'));
    InspectorTest.log('');
  }
}

InspectorTest.logSourceLocations = function(locations) {
  if (locations.length == 0) return Promise.resolve();
  return InspectorTest.logSourceLocation(locations[0])
      .then(() => InspectorTest.logSourceLocations(locations.splice(1)));
}

InspectorTest.logAsyncStackTrace = function(asyncStackTrace)
{
  while (asyncStackTrace) {
    if (asyncStackTrace.promiseCreationFrame) {
      var frame = asyncStackTrace.promiseCreationFrame;
      InspectorTest.log(`-- ${asyncStackTrace.description} (${frame.url
                        }:${frame.lineNumber}:${frame.columnNumber})--`);
    } else {
      InspectorTest.log(`-- ${asyncStackTrace.description} --`);
    }
    InspectorTest.logCallFrames(asyncStackTrace.callFrames);
    asyncStackTrace = asyncStackTrace.parent;
  }
}

InspectorTest.completeTest = () => Protocol.Debugger.disable().then(() => utils.quit());

InspectorTest.completeTestAfterPendingTimeouts = function()
{
  InspectorTest.waitPendingTasks().then(InspectorTest.completeTest);
}

InspectorTest.waitPendingTasks = function()
{
  return Protocol.Runtime.evaluate({ expression: "new Promise(r => setTimeout(r, 0))//# sourceURL=wait-pending-tasks.js", awaitPromise: true });
}

InspectorTest.addScript = (string, lineOffset, columnOffset) => utils.compileAndRunWithOrigin(string, "", lineOffset || 0, columnOffset || 0, false);
InspectorTest.addScriptWithUrl = (string, url) => utils.compileAndRunWithOrigin(string, url, 0, 0, false);
InspectorTest.addModule = (string, url, lineOffset, columnOffset) => utils.compileAndRunWithOrigin(string, url, lineOffset || 0, columnOffset || 0, true);

InspectorTest.startDumpingProtocolMessages = function()
{
  InspectorTest._dumpInspectorProtocolMessages = true;
}

InspectorTest.sendRawCommand = function(requestId, command, handler, contextGroupId)
{
  if (InspectorTest._dumpInspectorProtocolMessages)
    utils.print("frontend: " + command);
  InspectorTest._dispatchTable.set(requestId, handler);
  sendMessageToBackend(command, contextGroupId || 0);
}

InspectorTest.checkExpectation = function(fail, name, messageObject)
{
  if (fail === !!messageObject.error) {
    InspectorTest.log("PASS: " + name);
    return true;
  }

  InspectorTest.log("FAIL: " + name + ": " + JSON.stringify(messageObject));
  InspectorTest.completeTest();
  return false;
}
InspectorTest.expectedSuccess = InspectorTest.checkExpectation.bind(null, false);
InspectorTest.expectedError = InspectorTest.checkExpectation.bind(null, true);

InspectorTest.setupScriptMap = function() {
  if (InspectorTest._scriptMap)
    return;
  InspectorTest._scriptMap = new Map();
}

InspectorTest.runTestSuite = function(testSuite)
{
  function nextTest()
  {
    if (!testSuite.length) {
      InspectorTest.completeTest();
      return;
    }
    var fun = testSuite.shift();
    InspectorTest.log("\nRunning test: " + fun.name);
    fun(nextTest);
  }
  nextTest();
}

InspectorTest.runAsyncTestSuite = async function(testSuite) {
  for (var test of testSuite) {
    InspectorTest.log("\nRunning test: " + test.name);
    await test();
  }
  InspectorTest.completeTest();
}

InspectorTest._sendCommandPromise = function(method, params, contextGroupId)
{
  var requestId = ++InspectorTest._requestId;
  var messageObject = { "id": requestId, "method": method, "params": params };
  var fulfillCallback;
  var promise = new Promise(fulfill => fulfillCallback = fulfill);
  InspectorTest.sendRawCommand(requestId, JSON.stringify(messageObject), fulfillCallback, contextGroupId);
  return promise;
}

InspectorTest._waitForEventPromise = function(eventName)
{
  return new Promise(fulfill => InspectorTest._eventHandler[eventName] = fullfillAndClearListener.bind(null, fulfill));

  function fullfillAndClearListener(fulfill, result)
  {
    delete InspectorTest._eventHandler[eventName];
    fulfill(result);
  }
}

InspectorTest._dispatchMessage = function(messageObject)
{
  if (InspectorTest._dumpInspectorProtocolMessages)
    utils.print("backend: " + JSON.stringify(messageObject));
  try {
    var messageId = messageObject["id"];
    if (typeof messageId === "number") {
      var handler = InspectorTest._dispatchTable.get(messageId);
      if (handler) {
        handler(messageObject);
        InspectorTest._dispatchTable.delete(messageId);
      }
    } else {
      var eventName = messageObject["method"];
      var eventHandler = InspectorTest._eventHandler[eventName];
      if (InspectorTest._scriptMap && eventName === "Debugger.scriptParsed")
        InspectorTest._scriptMap.set(messageObject.params.scriptId, JSON.parse(JSON.stringify(messageObject.params)));
      if (eventName === "Debugger.scriptParsed" && messageObject.params.url === "wait-pending-tasks.js")
        return;
      if (eventHandler)
        eventHandler(messageObject);
    }
  } catch (e) {
    InspectorTest.log("Exception when dispatching message: " + e + "\n" + e.stack + "\n message = " + JSON.stringify(messageObject, null, 2));
    InspectorTest.completeTest();
  }
}

InspectorTest.loadScript = function(fileName) {
  InspectorTest.addScript(utils.read(fileName));
}
