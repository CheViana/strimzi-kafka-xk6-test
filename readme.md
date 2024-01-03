# Performance testing Strimzi Kafka in the k8s cluster using xk6-kafka

I'm going to describe how to performance test reading/writing from Kafka topic with multiple partitions using [xk6-kafka plugin](https://github.com/mostafa/xk6-kafka) for k6.

Here's topic definition, using [Strimzi Kafka](https://strimzi.io/):

```
apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaTopic
metadata:
  name: my-topic
  namespace: kafka
  labels:
    strimzi.io/cluster: cluster-1
spec:
  partitions: 3
  replicas: 1
  config:
   ...
```

This topic has three partitions so it makes sense to test it with three virtual users, each reading from a separate partition.
It also makes sense to me to write all messages at the beginning, using virtual user number 1, as the messages it writes will be distributed to the three partitions round-robin.
Alternatively, virtual user can have a writer that produces to partition=virtual-user-number and reader that consumes from partition=virtual-user-number. I like this case less as it ties reader and writer, and hence is not very close to common real-world examples.

So test scenario is going to execute like this:

```
Virtual user 0: setup code, instantiate producer
Virtual user 1: produce 1000 messages, read 333 messages from partition 0
Virtual user 2: read 333 messages from partition 1
Virtual user 3: read 333 messages from partition 2
Virtual user 0: teardown producer after the test is done
```


Here's the code for the scenario script. It has debug prints that can be helpful to inspect how messages are consumed by virtual users.

An important aspect is that it is important to set `groupID`, `groupTopics` and `groupBalancers` when using Kafka bootstrap server. ReaderConfig has param `topic` which doesn't quite work with bootstrap server, it works with Kafka broker's address directly and with explicit partition number set.

Another important aspect is that `consumer` is instantiated in test code (`default` function) - meaning each virtual user will use it's own consumer object. All consumers should belong to same consumer group though (`groupID` param). It is important to close consumer at the end of the function.

```
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
```

Here's output this scenario produces. Offset for the first message of each consumer is not zero because topic had prior messages in it, and same consumer group has already read those. So offset is 33 to begin with.

```
          /\      |‾‾| /‾‾/   /‾‾/   
     /\  /  \     |  |/  /   /  /    
    /  \/    \    |     (   /   ‾‾\  
   /          \   |  |\  \ |  (‾)  | 
  / __________ \  |__| \__\ \_____/ .io

  execution: local
     script: /var/test-scenario/test-scenario.js
     output: -

  scenarios: (100.00%) 1 scenario, 3 max VUs, 10m30s max duration (incl. graceful stop):
           * default: 3 iterations shared among 3 VUs (maxDuration: 10m0s, gracefulStop: 30s)

time="2024-01-01T18:50:56Z" level=info msg="VU 1, writing messages. Iter 0" source=console

...

time="2024-01-01T18:51:01Z" level=info msg="Amount of msgs received: 333, VU 3, iter 0" source=console
time="2024-01-01T18:51:01Z" level=info msg="First msg value test-value-string-99-vu-1-iter-0, offset33, partition 0, VU 3, iter 0" source=console
time="2024-01-01T18:51:01Z" level=info msg="Last msg value test-value-string-993-vu-1-iter-0, offset365, partition 0, VU 3, iter 0" source=console

...

time="2024-01-01T18:51:01Z" level=info msg="Amount of msgs received: 333, VU 1, iter 0" source=console
time="2024-01-01T18:51:01Z" level=info msg="First msg value test-value-string-2-vu-1-iter-0, offset33, partition 2, VU 1, iter 0" source=console
time="2024-01-01T18:51:01Z" level=info msg="Last msg value test-value-string-998-vu-1-iter-0, offset365, partition 2, VU 1, iter 0" source=console
time="2024-01-01T18:51:01Z" level=info msg="Amount of msgs received: 333, VU 2, iter 0" source=console
time="2024-01-01T18:51:01Z" level=info msg="First msg value test-value-string-1-vu-1-iter-0, offset33, partition 1, VU 2, iter 0" source=console
time="2024-01-01T18:51:01Z" level=info msg="Last msg value test-value-string-997-vu-1-iter-0, offset365, partition 1, VU 2, iter 0" source=console

...


     ✓ all messages returned
     ✓ Topic equals to

     █ teardown

     checks.............................: 100.00%     ✓ 6             ✗ 0            
     ...  
     iterations.........................: 3           
     kafka_reader_dial_count............: 3           
     ... 
   ✓ kafka_reader_error_count...........: 0           0/s
     kafka_reader_fetch_bytes...........: 66 kB              
     kafka_reader_fetches_count.........: 6           
     kafka_reader_lag...................: 0           min=0           max=0          
     kafka_reader_message_bytes.........: 33 kB       
     kafka_reader_message_count.........: 1001        
     kafka_reader_offset................: 366         min=366         max=368        
     ...  
     kafka_reader_rebalance_count.......: 3           
     kafka_reader_timeouts_count........: 0           
     ...                  
     kafka_writer_batch_bytes...........: 56 kB       
     kafka_writer_batch_max.............: 1           min=1           max=1          
     ... 
     kafka_writer_batch_size............: 1000        
     ... 
   ✓ kafka_writer_error_count...........: 0           0/s
     kafka_writer_message_bytes.........: 56 kB       
     kafka_writer_message_count.........: 1000        
     ...      
     kafka_writer_write_count...........: 1000        
     ...
     vus................................: 3           min=3           max=3          
     vus_max............................: 3           min=3           max=3          


running, 0/3 VUs, 3 complete and 0 interrupted iterations
default ✓ [ 100% ] 3 VUs  3/3 shared iters
```

Here's pod definition that can be used to run this script in the k8s cluster:

```
apiVersion: v1
kind: Pod
metadata:
  creationTimestamp: null
  labels:
    app: test-xk6-loadtest
  name: test-xk6-loadtest-1
  namespace: loadtest
spec:
  containers:
  - args:
    - run
    - '/var/test-scenario/test-scenario.js'
    image: mostafamoradian/xk6-kafka:latest
    name: loadtest-xk6
    resources: {}
    volumeMounts:
    - mountPath: /var/test-scenario
      name: test-scenario
  dnsPolicy: ClusterFirst
  volumes:
    - name: test-scenario
      configMap:
        name: kx6-test-scenario
  restartPolicy: Never
status: {}
```

Here's commands to run the scenario in your k8s cluster:

```
kubectl create --namespace kafka topic.yaml <-- Strimzi definition of my-topic, see above
kubectl create --namespace loadtest configmap kx6-test-scenario --from-file=test-scenario.js
kubectl apply -f test-pod.yml  <-- Pod definition, see above
```

See test results using:

```
kubectl logs test-xk6-loadtest-1 -n loadtest -f
```



In case your kafka cluster has TLS or other auth options enabled, xk6-kafka repo has useful [examples](https://github.com/mostafa/xk6-kafka/blob/main/scripts/test_sasl_auth.js) on how to setup those. Can mount server cert in the pod using volumes and volumeMounts.

Happy New Year!
