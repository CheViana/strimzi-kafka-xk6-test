import {
    Writer,
    Reader,
    SCHEMA_TYPE_STRING,
    SchemaRegistry,
    GROUP_BALANCER_ROUND_ROBIN,
    SECONDS
} from "k6/x/kafka";
import { check } from "k6";

const bootstrapServers = [
  'localhost:9091',
];

export const options = {
    vus: 3,
    duration: "3h",
    thresholds: {
        kafka_writer_error_count: ["count == 0"],
        kafka_reader_error_count: ["count == 0"],
    },
};

const topicName = "topic1";
const schemaRegistry = new SchemaRegistry();



export default function () {

  let messageAmount = 9;
  let batchSize = 10;

    const producer = new Writer({
      brokers: bootstrapServers,
      topic: topicName,
      balancer: "balancer_roundrobin",
      requiredAcks: 1,
      batchSize: batchSize,
      maxAttempts: 3,
      connectLogger: true,
    });

    console.log('VU 1, writing messages. Iter ' + __ITER);
    let firstMessageContent = null;
    let lastMessageContent = null;
    for (let index = 0; index < messageAmount; index++) { 
        let msgContent = "test-value-string-" + index + "-vu-" + __VU + "-iter-" + __ITER;
        if (index == 0) {
          firstMessageContent = msgContent;
        }
        if (index == messageAmount - 1) {
          lastMessageContent = msgContent;
        }
        let messages = [];
        for (let i = 0; i < batchSize; i++) {
          messages.push({
            value: schemaRegistry.serialize({
              data: msgContent,
              schemaType: SCHEMA_TYPE_STRING,
            }),
          });
        }
        producer.produce({ messages: messages });
        
    }
    producer.close();
    console.log("First published msg: " + firstMessageContent);
    console.log("Last published msg: " + lastMessageContent);

    const consumer = new Reader({
      brokers: bootstrapServers,
      groupID: topicName + "-group",
      groupTopics: [topicName],
      groupBalancers: [GROUP_BALANCER_ROUND_ROBIN],
      maxAttempts: 3,
      connectLogger: true,
      commitInterval: 0.7 * SECONDS,
      heartbeatInterval: 2.3 * SECONDS,
    });

    let messages = consumer.consume({ limit: messageAmount * batchSize});

    console.log("Amount of msgs received: " + messages.length + ", VU " + __VU + ", iter " + __ITER);

    if (messages.length) {

      check(messages[0], {
        "Topic equals to": (msg) => msg["topic"] == topicName
      });

    } else {
      console.log("No messages received");
    }
    consumer.close();
}
