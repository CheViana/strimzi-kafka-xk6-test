import {
    Writer,
    Reader,
    SCHEMA_TYPE_STRING,
    SchemaRegistry,
    GROUP_BALANCER_ROUND_ROBIN,
    BALANCER_ROUND_ROBIN,
} from "k6/x/kafka";
import { check, sleep } from "k6";


const bootstrapServers = [
  'kafka-bootsrap-1:9001',
];

let vus_amount = 3;
let total_written = 0;
let total_read = 0;

export const options = {
    vus: vus_amount,
    iterations: "3",
    thresholds: {
        kafka_writer_error_count: ["count == 0"],
        kafka_reader_error_count: ["count == 0"],
    },
};

const topicName = "my-topic";
const schemaRegistry = new SchemaRegistry();

const producer = new Writer({
    brokers: bootstrapServers,
    topic: topicName,
    balancer: BALANCER_ROUND_ROBIN,  // or pick another balancer https://github.com/mostafa/xk6-kafka/blob/main/api-docs/index.d.ts#L66
    // ... auth config
});


export function teardown(data) {
    producer.close();
}

export default function () {
  const consumer = new Reader({
    brokers: bootstrapServers,
    // it is important to set groupID, groupTopics and groupBalancers when using Kafka bootstrap server
    // topic ReaderConfig param doesn't quite work with bootstrap server
    groupID: topicName + "-group",
    groupTopics: [topicName],
    groupBalancers: [GROUP_BALANCER_ROUND_ROBIN], // or pick different balancer https://github.com/mostafa/xk6-kafka/blob/main/api-docs/index.d.ts#L75
  });

  let messageAmount = 1000;

  if (__VU == 1) {
    console.log('VU 1, writing messages. Iter ' + __ITER);
    for (let index = 0; index < messageAmount; index++) { 
        let messages = [
          {
            value: schemaRegistry.serialize({
              data: "test-value-string-" + index + "-vu-" + __VU + "-iter-" + __ITER,
              schemaType: SCHEMA_TYPE_STRING,
            }),
          },
        ];
        producer.produce({ messages: messages });
        total_written += messages.length;
    }
  }

  let consumerMsgAmount = Math.floor(messageAmount / vus_amount);

  let messages = consumer.consume({ limit: consumerMsgAmount});
  total_read += messages.length;

  console.log("Amount of msgs received: " + messages.length + ", VU " + __VU + ", iter " + __ITER);
  check(messages, {
      "all messages returned": (msgs) => msgs.length == consumerMsgAmount,
  });

  let firstMessageValue = schemaRegistry.deserialize({
    data: messages[0].value,
    schemaType: SCHEMA_TYPE_STRING,
  });
  let lastMessageValue = schemaRegistry.deserialize({
    data: messages[consumerMsgAmount - 1].value,
    schemaType: SCHEMA_TYPE_STRING,
  });

  check(messages[0], {
    "Topic equals to": (msg) => msg["topic"] == topicName
  });

  console.log("First msg value " + firstMessageValue + ", offset" + messages[0]["offset"] + ", partition " + messages[0]["partition"] + ", VU " + __VU + ", iter " + __ITER);
  console.log("Last msg value " + lastMessageValue + ", offset" + messages[consumerMsgAmount - 1]["offset"] + ", partition " + messages[0]["partition"] + ", VU " + __VU + ", iter " + __ITER);
  consumer.close();
}
