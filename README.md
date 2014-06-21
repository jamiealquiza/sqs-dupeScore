sqs-dupeScore
==============

# Overview
A tool that is used to explore duplicate message events from Amazon SQS, a distributed message queue that favors availability and at least once delivery. dupeScore is designed to operate pools of queue workers across many servers, long-polling from a single SQS queue. 

Message bodies are SHA1 hashed and populated into a sorted set stored in Redis, scored by the number of times each unique event is handled by any worker. Additionally, each hash has a corresponding list that's populated with crude k-ordered IDs (epoch-nodeId-workerId) generated at the message request time, to track when the event was polled and from what node/worker.

# Example:


**Two nodes / 6 workers / batch size of 1 / 1500ms delete delay**
<pre>
out.log:
Fri Jun 20 2014 22:50:34 GMT+0000 (UTC) [INFO]: Listening for events on https://sqs.us-west-2.amazonaws.com/000/xxx
Fri Jun 20 2014 22:50:34 GMT+0000 (UTC) [INFO]: Listening for events on https://sqs.us-west-2.amazonaws.com/000/xxx
Fri Jun 20 2014 22:50:38 GMT+0000 (UTC) [INFO]: Events handled, last 5s: 1
Fri Jun 20 2014 22:50:41 GMT+0000 (UTC) [INFO]: Duplicate caught with hash ID: ee2d820bb411d3638b00f5dcd066cc77ed5c05e0
Fri Jun 20 2014 22:50:43 GMT+0000 (UTC) [INFO]: Events handled, last 5s: 1
Fri Jun 20 2014 22:50:48 GMT+0000 (UTC) [INFO]: Events handled, last 5s: 1
</pre>

**Top 10 messages sorted by dupe score, values 1-100**
<pre>
redis 127.0.0.1:6379> ZREVRANGEBYSCORE msgScores 100 2 WITHSCORES LIMIT 0 10
1) "ee2d820bb411d3638b00f5dcd066cc77ed5c05e0"
2) "2"
</pre>

**Reviewing logged IDs of event**
<pre>
redis 127.0.0.1:6379> lrange msg-ee2d820bb411d3638b00f5dcd066cc77ed5c05e0 0 -1
1) "1403304638284-0661600909f2-4"
2) "1403304609709-06155406b388-3"
</pre>
