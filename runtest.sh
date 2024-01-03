kubectl create --namespace kafka topic.yaml
kubectl create --namespace loadtest configmap kx6-test-scenario --from-file=test-scenario.js
kubectl apply -f test-pod.yml
sleep 30
kubectl logs test-xk6-loadtest -n loadtest -f
