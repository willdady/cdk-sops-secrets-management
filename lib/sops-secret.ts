import * as path from 'path';

import * as assets from 'aws-cdk-lib/aws-s3-assets';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodeJs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import { CustomResource, Duration, Stack } from 'aws-cdk-lib';

export interface ITag {
  readonly key: string;
  readonly value: string;
}

export interface IReplicaRegionType {
  readonly region: string;
  readonly kmsKeyId?: string;
}

export interface ISopsSecretProps {
  /**
   * Path to sops encrypted file on disk
   */
  readonly path: string;
  /**
   * The file type.
   *
   * Derived from file extension if not set explicitly.
   */
  readonly secretType?: 'json' | 'yaml' | 'dotenv' | 'txt';
  /**
   * The name to use when storing the contents of the encrypted file in AWS
   * Secrets Manager
   */
  readonly secretName: string;
  /**
   * AWS KMS key arn used to encrypt/decrypt the file
   */
  readonly kmsKeyArn: string;
  /**
   * The ARN of the KMS key that Secrets Manager uses to
   * encrypt the secret value in the secret.
   *
   * If you don't specify this value, then Secrets Manager uses the key
   * `aws/secretsmanager`.
   */
  readonly secretKmsKeyArn?: string;
  /**
   * The description of the secret in AWS Secrets Manager
   */
  readonly secretDescription?: string;
  /**
   * Tags to apply to the secret in AWS Secrets Manager
   */
  readonly secretTags?: ITag[];
  /**
   * The resource-based policy to apply to the secret in AWS Secrets Manager
   */
  readonly secretPolicy?: iam.PolicyDocument;
  /**
   * List of AWS regions to replicate the secret to
   */
  readonly secretReplicaRegions?: IReplicaRegionType[];
}

export class SopsSecret extends Construct {
  private static nameTracker: { [key: string]: boolean } = {};

  /**
   * Stores secrets encrypted using Mozilla Sops in AWS Secrets Manager
   */
  constructor(scope: Construct, id: string, props: ISopsSecretProps) {
    super(scope, id);

    // Check that props.secretName is unique. Note we only check secretName is
    // unique within the current stack! We don't check globally as this leads to
    // false-positives when running unit tests as we don't want to share this
    // state across tests.
    const stack = Stack.of(this);
    const trackingKey = `${stack.stackId}-${props.secretName}`;
    if (trackingKey in SopsSecret.nameTracker)
      throw new Error('SopsSecret must have unique secretName');
    SopsSecret.nameTracker[trackingKey] = true;

    // Validate tags
    if (props.secretTags && props.secretTags.length > 50)
      throw new Error('Can not set more-than 50 tags');

    // If secretType is not set, derive it from the file extension
    let secretType: string;
    if (props.secretType) {
      secretType = props.secretType;
    } else {
      const fileExtension = path.extname(props.path);
      switch (fileExtension) {
        case '.json':
          secretType = 'json';
          break;
        case '.yaml':
          secretType = 'yaml';
          break;
        case '.yml':
          secretType = 'yaml';
          break;
        case '.env':
          secretType = 'dotenv';
          break;
        case '.txt':
          secretType = 'txt';
          break;
        default:
          throw new Error('Could not infer file type from file name');
      }
    }

    const asset = new assets.Asset(this, 'SopsFile', {
      path: props.path,
    });

    const provider = this.getOrCreateProvider();
    provider.onEventHandler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['kms:Decrypt', 'kms:DescribeKey', 'kms:GenerateDataKey'],
        resources: [props.kmsKeyArn],
      }),
    );
    if (props.secretKmsKeyArn) {
      provider.onEventHandler.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['kms:Decrypt', 'kms:DescribeKey', 'kms:GenerateDataKey'],
          resources: [props.secretKmsKeyArn],
        }),
      );
    }
    asset.grantRead(provider.onEventHandler);

    new CustomResource(this, 'SopsSecretCustomResource', {
      serviceToken: provider.serviceToken,
      resourceType: 'Custom::SopsSecret',
      properties: {
        SecretName: props.secretName,
        SecretType: secretType,
        SecretDescription: props.secretDescription,
        S3BucketName: asset.s3BucketName,
        S3ObjectKey: asset.s3ObjectKey,
        SecretKmsKeyArn: props.secretKmsKeyArn,
        SecretTags: props.secretTags
          ? JSON.stringify(
              props.secretTags.map(({ key, value }) => [key, value]),
            )
          : undefined,
        SecretPolicy: props.secretPolicy
          ? JSON.stringify(props.secretPolicy)
          : undefined,
        SecretReplicaRegions: props.secretReplicaRegions
          ? JSON.stringify(props.secretReplicaRegions)
          : undefined,
      },
    });
  }

  private getOrCreateProvider() {
    const stack = Stack.of(this);
    const id = 'SecretCreatorProvider';
    const provider = stack.node.tryFindChild(id) as cr.Provider;
    if (provider) return provider;

    const sopsLayer = new lambda.LayerVersion(stack, 'SopsLayer', {
      code: lambda.Code.fromAsset(path.join(__dirname, 'sops-layer')),
      description: 'Contains Mozilla sops',
      compatibleArchitectures: [lambda.Architecture.X86_64],
      compatibleRuntimes: [lambda.Runtime.NODEJS_16_X],
    });

    const secretUpdaterFunction = new lambdaNodeJs.NodejsFunction(
      stack,
      'secret-updater',
      {
        timeout: Duration.minutes(5),
        layers: [sopsLayer],
        handler: 'onEvent',
        memorySize: 256,
        runtime: lambda.Runtime.NODEJS_16_X,
      },
    );
    secretUpdaterFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'secretsmanager:CreateSecret',
          'secretsmanager:UpdateSecret',
          'secretsmanager:DeleteSecret',
          'secretsmanager:DescribeSecret',
          'secretsmanager:ListSecrets',
          'secretsmanager:PutSecretValue',
          'secretsmanager:GetResourcePolicy',
          'secretsmanager:PutResourcePolicy',
          'secretsmanager:DeleteResourcePolicy',
          'secretsmanager:TagResource',
          'secretsmanager:UntagResource',
          'secretsmanager:ReplicateSecretToRegions',
          'secretsmanager:RemoveRegionsFromReplication',
        ],
        resources: ['*'],
      }),
    );

    return new cr.Provider(stack, id, {
      onEventHandler: secretUpdaterFunction,
    });
  }
}
