#!/usr/bin/env node

// The MIT License (MIT)
//
// Copyright (c) 2014 Jamie Alquiza
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
// THE SOFTWARE.

var settings = require('./settings.js');
var fs = require('fs');
var crypto = require('crypto');
var cluster = require('cluster');
var AWS = require('aws-sdk');
var redis = require('redis');

// --- Master Process --- //

if (cluster.isMaster) {
  for (var i = 0; i < settings.workers; i++) {
    cluster.fork();
  }

  // Log events handled on interval
  var eventsHandled = 0;
  setInterval(function() {
    if (eventsHandled > 0) {
      writeLog("Events handled, last 5s: " + eventsHandled, "INFO");
      eventsHandled = 0;
    }
  }, 5000);

  // Worker message handler 
  function messageHandler(msg) {
    if (msg.cmd && msg.cmd == 'eventCount') {
      eventsHandled += msg.count;
    }
  }

  // Worker message listener
  Object.keys(cluster.workers).forEach(function(id) {
    cluster.workers[id].on('message', messageHandler);
  });

  // Respawn failed workers
  var respawnCount = 0;
  cluster.on('exit', function(worker, code, signal) {
    if (respawnCount <= 5) {
      writeLog("Worker died, respawning", "WARN");
      cluster.fork();
      respawnCount ++;
    } 
    else {
      writeLog("Respawn limit reached, master process exiting", "WARN");
      process.exit(1);
    } 
  });

} else {

// --- Worker Processes --//

  // --- Init & Misc. --- //

  AWS.config.update({
    accessKeyId: settings.sqs.accessKeyId,
    secretAccessKey: settings.sqs.secretAccessKey,
    region: settings.sqs.region
  });

  function writeLog(message, level) {
    if (settings.logConsole) {
      console.log(Date() + " [" + level + "]: " + message);
    } 
    else {
      fs.appendFile(settings.logFile, Date() + " [" + level + "]: " + message + "\n", function (err) {
        if (err) throw err;
      });
    }
  }

  function hashId(input) {
    var hash = crypto.createHash('sha1');
    hash.setEncoding('hex');
    hash.write(input);
    hash.end();
    return hash.read();
  }

  function genId(timeStamp) {
    // timeStamp gen'd immediately before SQS poll req time accuracy
    return timeStamp + "-" + settings.nodeId + "-" + cluster.worker.id;
  }

  // --- Output: Redis --- //

  // Init
  clientRedis = redis.createClient(settings.redis.port, settings.redis.host);

  // General
  function scoreMsg(digests, receipts, timeStamp) {
    for (var i=0; i < digests.length; i++) {
      var hash = digests[i];
      clientRedis.lpush("msg-" + hash, genId(timeStamp), function (err, res) {
        if (err) writeLog(err, "WARN");
      });
      clientRedis.zincrby("msgScores", 1, hash, function (err, res) { 
        if (err) writeLog(err, "WARN");
        if (res > 1) {
          writeLog("Duplicate caught with hash ID: " + hash, "INFO");
        } 
      });
    }
    process.send({ cmd: 'eventCount', count: digests.length });
    setTimeout(delSqsMsg(receipts), settings.sqs.delDelay);
  }

  // --- Input: AWS SQS --- //

  // Init
  var sqsParams = {
    QueueUrl: settings.sqs.sqsUrl,
    MaxNumberOfMessages: settings.sqs.batchSize,
    WaitTimeSeconds: 5,
  }

  function estabSqs() {
    clientSqs = new AWS.SQS({region: settings.sqs.region});
    clientSqs.getQueueAttributes({QueueUrl: settings.sqs.sqsUrl}, function(err, data) {
      if (err) {
        writeLog(err, "WARN");
      } 
      else {
        writeLog("Listening for events on " + settings.sqs.sqsUrl, "INFO");
      }
    });
  }

  // General
  function parseSqsMsg(messages, timeStamp) {
    var digests = [];
    var receipts = [];
    var receipt = {};
    for (var msg = 0; msg < messages.length; msg++) {
      var rcpt = messages[msg].ReceiptHandle;
      var body = JSON.parse(messages[msg].Body);
      var digest = hashId(JSON.stringify(body.Message));
      receipt = { Id: msg.toString(), ReceiptHandle: rcpt };
      digests.push(digest);
      receipts.push(receipt);
    }
     scoreMsg(digests, receipts, timeStamp);
  }

  function pollSqs() {
    var timeStamp = Date.now();
    clientSqs.receiveMessage(sqsParams, function (err, data) {
      if (err) {
        writeLog(err, "WARN");
      } 
      else {
        if (data.Messages) {
          parseSqsMsg(data.Messages, timeStamp);
        }
        pollSqs(); 
      }
    });
  }

  function delSqsMsg(receipts) {
    clientSqs.deleteMessageBatch({
      QueueUrl: settings.sqs.sqsUrl,
      Entries: receipts
    }, function(err, resp) {
      if (err) writeLog(err, "WARN");
    });
  }

  // Service
  estabSqs(); // Initial connection
  setInterval(estabSqs, 300000); // Refresh conn; AWS API has 15 min timeout
  pollSqs();

}
