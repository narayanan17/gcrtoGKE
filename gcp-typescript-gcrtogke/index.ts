// Copyright 2016-2019, Pulumi Corporation.  All rights reserved.

import * as gcp from "@pulumi/gcp";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import * as docker from "@pulumi/docker";



const config = new pulumi.Config();
const configFile = config.require("docker-config-file");
const name = "musicstore-"+config.require("envrionment");

const imageName = "musicstore";

const gcrDockerProvider = new docker.Provider('gcr', {
    registryAuth: [{
        address: "gcr.io",
        configFile: configFile
    }],
    });

    
    const registryImage = pulumi.output(
    docker.getRegistryImage({
    name: `gcr.io/${gcp.config.project}/${imageName}:latest`,
    }, {provider: gcrDockerProvider}));

// Using the value from the registryImage to pull the image if it's new, pullTriggers looks for a new sha. 
var dockerImage = registryImage.apply(r => new docker.RemoteImage(`${imageName}-docker-image`, {
    name: r.name!,
    pullTriggers: [registryImage.sha256Digest!],
    keepLocally: true
}, {provider: gcrDockerProvider}));



export const masterVersion = config.get("masterVersion") ||
    gcp.container.getEngineVersions().then(it => it.latestMasterVersion);

// Create a GKE cluster
const cluster = new gcp.container.Cluster(name, {
    // We can't create a cluster with no node pool defined, but we want to only use
    // separately managed node pools. So we create the smallest possible default
    // node pool and immediately delete it.
    initialNodeCount: 1,
    removeDefaultNodePool: true,

    minMasterVersion: masterVersion,
});

const nodePool = new gcp.container.NodePool(`primary-node-pool`, {
    cluster: cluster.name,
    initialNodeCount: 2,
    location: cluster.location,
    nodeConfig: {
        preemptible: true,
        machineType: "n1-standard-1",
        oauthScopes: [
            "https://www.googleapis.com/auth/compute",
            "https://www.googleapis.com/auth/devstorage.read_only",
            "https://www.googleapis.com/auth/logging.write",
            "https://www.googleapis.com/auth/monitoring",
        ],
    },
    version: masterVersion,
    management: {
        autoRepair: true,
    },
}, {
    dependsOn: [cluster],
});

// Export the Cluster name
export const clusterName = cluster.name;

// Manufacture a GKE-style kubeconfig. Note that this is slightly "different"
// because of the way GKE requires gcloud to be in the picture for cluster
// authentication (rather than using the client cert/key directly).
 const kubeconfig = pulumi.
    all([ cluster.name, cluster.endpoint, cluster.masterAuth ]).
    apply(([ name, endpoint, masterAuth ]) => {
        const context = `${gcp.config.project}_${gcp.config.zone}_${name}`;
        return `apiVersion: v1
clusters:
- cluster:
    certificate-authority-data: ${masterAuth.clusterCaCertificate}
    server: https://${endpoint}
  name: ${context}
contexts:
- context:
    cluster: ${context}
    user: ${context}
  name: ${context}
current-context: ${context}
kind: Config
preferences: {}
users:
- name: ${context}
  user:
    auth-provider:
      config:
        cmd-args: config config-helper --format=json
        cmd-path: gcloud
        expiry-key: '{.credential.token_expiry}'
        token-key: '{.credential.access_token}'
      name: gcp
`;
    });

// Create a Kubernetes provider instance that uses our cluster from above.
const clusterProvider = new k8s.Provider(name, {
    kubeconfig: kubeconfig,
}, {
  dependsOn: [nodePool],
});

// Create a Kubernetes Namespace
const ns = new k8s.core.v1.Namespace(name, {}, { provider: clusterProvider });

// Export the Namespace name
export const namespaceName = ns.metadata.name;
export const clusterMasterIP = cluster.endpoint;

// Create a NGINX Deployment
const appLabels = { appClass: name };
const deployment = new k8s.apps.v1.Deployment(name,
    {
        metadata: {
            namespace: namespaceName,
            labels: appLabels,
        },
        spec: {
            replicas: 1,
            selector: { matchLabels: appLabels },
            template: {
                metadata: {
                    labels: appLabels,
                },
                spec: {
                    containers: [
                        {
                            name: name,
                            image: dockerImage.name,
                            ports: [{ name: "http", containerPort: 80 }],
                        },
                    ],
                },
            },
        },
    },
    {
        provider: clusterProvider,
    },
);

// Export the Deployment name
export const deploymentName = deployment.metadata.name;

// Create a LoadBalancer Service for the NGINX Deployment
const service = new k8s.core.v1.Service(name,
    {
        metadata: {
            labels: appLabels,
            namespace: namespaceName,
        },
        spec: {
            type: "LoadBalancer",
            ports: [{ port: 80, targetPort: "http" }],
            selector: appLabels,
        },
    },
    {
        provider: clusterProvider,
    },
);

// Export the Service name and public LoadBalancer endpoint
export const serviceName = service.metadata.name;
export const servicePublicIP = service.status.loadBalancer.ingress[0].ip;

