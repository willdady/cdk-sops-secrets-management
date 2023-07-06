import * as util from 'util';
import { Readable } from 'stream';
import * as childProcess from 'child_process';

import {
  CreateSecretCommand,
  DeleteResourcePolicyCommand,
  DeleteSecretCommand,
  DescribeSecretCommand,
  DescribeSecretResponse,
  PutResourcePolicyCommand,
  RemoveRegionsFromReplicationCommand,
  ReplicateSecretToRegionsCommand,
  ResourceNotFoundException,
  SecretsManagerClient,
  TagResourceCommand,
  UntagResourceCommand,
  UpdateSecretCommand,
} from '@aws-sdk/client-secrets-manager';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';

const exec = util.promisify(childProcess.exec);

const secretsManagerClient = new SecretsManagerClient({});
const s3Client = new S3Client({});

interface ResourceProperties {
  SecretName: string;
  SecretType: 'json' | 'yaml' | 'dotenv' | 'txt';
  S3BucketName: string;
  S3ObjectKey: string;
  SecretKmsKeyArn?: string;
  SecretDescription?: string;
  SecretTags?: string; // JSON string
  SecretPolicy?: string; // JSON string
  SecretReplicaRegions?: string; // JSON string
}

type RequestType = 'Create' | 'Update' | 'Delete';

interface BaseEvent {
  RequestType: RequestType;
}

interface CreateEvent extends BaseEvent {
  ResourceProperties: ResourceProperties;
}

interface UpdateEvent extends CreateEvent {
  PhysicalResourceId: string;
}

interface DeleteEvent extends BaseEvent {
  PhysicalResourceId: string;
}

interface Response {
  PhysicalResourceId: string;
}

type Event = CreateEvent | UpdateEvent | DeleteEvent;

function streamToString(stream: Readable): Promise<string> {
  const chunks: Uint8Array[] = [];
  return new Promise((resolve, reject) => {
    stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on('error', (err) => reject(err));
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

const decodeSops = async (
  content: string,
  inputType: 'json' | 'yaml' | 'dotenv' | 'txt',
) => {
  const { stdout, stderr } = await exec(
    `echo '${content}' | /opt/sops -d --input-type ${inputType} --output-type ${inputType} -d /dev/stdin`,
  );
  if (stderr) {
    throw new Error(`sops command failed with: ${stderr}`);
  }
  return stdout;
};

const upsertSecret = async (props: ResourceProperties) => {
  // Get encoded secret file from S3 and decode it using sops
  const response = await s3Client.send(
    new GetObjectCommand({
      Bucket: props.S3BucketName,
      Key: props.S3ObjectKey,
    }),
  );
  const stream = response.Body! as Readable;
  let secretBody = await streamToString(stream);

  console.log(`Decoding secret ${props.SecretName}`);
  const decodedSecret = await decodeSops(secretBody, props.SecretType);
  console.log(`Successfully decoded secret`);

  // Check if the secret already exists and grab it's tags and replica regions if it does
  let secretExists;
  let existingTags: DescribeSecretResponse['Tags'];
  let existingReplicaRegions: DescribeSecretResponse['ReplicationStatus'];
  try {
    const response = await secretsManagerClient.send(
      new DescribeSecretCommand({
        SecretId: props.SecretName,
      }),
    );
    secretExists = true;
    existingTags = response.Tags;
    existingReplicaRegions = response.ReplicationStatus;
  } catch (err) {
    if (err instanceof ResourceNotFoundException) {
      secretExists = false;
    } else {
      throw err;
    }
  }

  // Update or create the secret
  if (secretExists) {
    await secretsManagerClient.send(
      new UpdateSecretCommand({
        SecretId: props.SecretName,
        Description: props.SecretDescription,
        SecretString: decodedSecret.trim(),
        KmsKeyId: props.SecretKmsKeyArn,
      }),
    );
  } else {
    await secretsManagerClient.send(
      new CreateSecretCommand({
        Name: props.SecretName,
        Description: props.SecretDescription,
        SecretString: decodedSecret.trim(),
        KmsKeyId: props.SecretKmsKeyArn,
      }),
    );
  }

  // Parse tags (if they exist in props)
  const newTags: [string, string][] = props.SecretTags
    ? JSON.parse(props.SecretTags)
    : [];

  // Remove existing tags not present in props.Tags
  if (existingTags?.length) {
    const tagKeys = newTags.map(([key]) => key);
    const tagsToRemove = existingTags.filter(
      ({ Key }) => !tagKeys.includes(Key!),
    );
    if (tagsToRemove.length) {
      await secretsManagerClient.send(
        new UntagResourceCommand({
          SecretId: props.SecretName,
          TagKeys: existingTags.map(({ Key }) => Key!),
        }),
      );
    }
  }

  // Add tags to secret
  if (newTags.length) {
    await secretsManagerClient.send(
      new TagResourceCommand({
        SecretId: props.SecretName,
        Tags: newTags.map(([Key, Value]) => ({ Key, Value })),
      }),
    );
  }

  // Update the resource policy or delete it if not defined in props
  if (props.SecretPolicy) {
    await secretsManagerClient.send(
      new PutResourcePolicyCommand({
        SecretId: props.SecretName,
        ResourcePolicy: props.SecretPolicy,
      }),
    );
  } else {
    try {
      await secretsManagerClient.send(
        new DeleteResourcePolicyCommand({
          SecretId: props.SecretName,
        }),
      );
    } catch (err) {
      if (!(err instanceof ResourceNotFoundException)) throw err;
    }
  }

  // Parse replica regions (if they exist in props)
  const newReplicatRegions:
    | {
        region: string;
        kmsKeyId?: string;
      }[] = props.SecretReplicaRegions
    ? JSON.parse(props.SecretReplicaRegions)
    : [];

  // Remove existing replica regions not present in props.SecretReplicaRegions
  if (secretExists && existingReplicaRegions?.length) {
    const regionNames = newReplicatRegions.map((r) => r.region);
    const existingRegionNames = existingReplicaRegions.map((r) => r.Region!);
    const regionsToRemove = existingRegionNames.filter(
      (regionName) => !regionNames.includes(regionName),
    );
    if (regionsToRemove.length) {
      await secretsManagerClient.send(
        new RemoveRegionsFromReplicationCommand({
          SecretId: props.SecretName,
          RemoveReplicaRegions: regionsToRemove,
        }),
      );
    }
  }

  // Add new replica regions
  if (newReplicatRegions?.length) {
    await secretsManagerClient.send(
      new ReplicateSecretToRegionsCommand({
        SecretId: props.SecretName,
        AddReplicaRegions: newReplicatRegions.map(({ region, kmsKeyId }) => ({
          Region: region,
          KmsKeyId: kmsKeyId,
        })),
      }),
    );
  }
};

const handleCreate = async (event: CreateEvent): Promise<Response> => {
  const props = event.ResourceProperties;
  console.log(`Creating secret ${props.SecretName}`);
  await upsertSecret(props);
  return {
    PhysicalResourceId: props.SecretName,
  };
};

const handleUpdate = async (event: UpdateEvent): Promise<Response> => {
  console.log(`Updating secret ${event.PhysicalResourceId}`);
  const props = event.ResourceProperties;
  await upsertSecret(props);
  return {
    PhysicalResourceId: event.PhysicalResourceId,
  };
};

const handleDelete = async (event: DeleteEvent): Promise<Response> => {
  console.log(`Deleting secret ${event.PhysicalResourceId}`);
  // Describe secret
  let describeSecretResponse;
  try {
    describeSecretResponse = await secretsManagerClient.send(
      new DescribeSecretCommand({
        SecretId: event.PhysicalResourceId,
      }),
    );
  } catch (err) {
    if (!(err instanceof ResourceNotFoundException)) {
      throw err;
    }
    return {
      PhysicalResourceId: event.PhysicalResourceId,
    };
  }
  // Delete replica regions from secret
  if (describeSecretResponse.ReplicationStatus?.length) {
    await secretsManagerClient.send(
      new RemoveRegionsFromReplicationCommand({
        SecretId: event.PhysicalResourceId,
        RemoveReplicaRegions: describeSecretResponse.ReplicationStatus.map(
          (item) => item.Region!,
        ),
      }),
    );
  }
  // Delete the secret
  await secretsManagerClient.send(
    new DeleteSecretCommand({
      SecretId: event.PhysicalResourceId,
      ForceDeleteWithoutRecovery: true,
    }),
  );
  return {
    PhysicalResourceId: event.PhysicalResourceId,
  };
};

export const onEvent = (event: Event): Promise<Response> => {
  try {
    const eventType = event.RequestType as string;
    switch (eventType) {
      case 'Create':
        return handleCreate(event as CreateEvent);
      case 'Update':
        return handleUpdate(event as UpdateEvent);
      case 'Delete':
        return handleDelete(event as DeleteEvent);
    }
    throw new Error(`Unknown event type ${eventType}`);
  } catch (err) {
    return Promise.reject(new Error('Failed'));
  }
};
