import * as path from 'path';
import { Stack, StackProps } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import { Construct } from 'constructs';

import { SopsSecret } from './sops-secret';

export interface SecretsManagementStackProps extends StackProps {
  /**
   * Organisation id
   */
  organisationId: string;
  /**
   * The arn of a KMS Key used to encrypt/decrypt secrets via Mozilla Sops
   */
  sopsMasterKeyArn: string;
  /**
   * Tags to apply to ALL Secrets Manager Secrets created by this stack
   */
  commonTags?: { key: string; value: string }[];
}

export class SecretsManagementStack extends Stack {
  private secretsManagerKmsKey: kms.Key;

  constructor(
    scope: Construct,
    id: string,
    props: SecretsManagementStackProps,
  ) {
    super(scope, id, props);

    // This custom KMS key is used when storing secrets in AWS Secrets Manager.
    // We must use a custom key to allow for reading secrets cross-accounts.
    this.secretsManagerKmsKey = new kms.Key(this, 'SecretsManagerKey', {
      description:
        'Used by cdk-sops-secrets-management for encrypting values in AWS Secrets Manager',
    });
    this.secretsManagerKmsKey.addToResourcePolicy(
      new iam.PolicyStatement({
        actions: [
          'kms:Decrypt',
          'kms:DescribeKey',
          'kms:GetKeyPolicy',
          'kms:ListKeyPolicies',
        ],
        principals: [new iam.OrganizationPrincipal(props.organisationId)],
        resources: ['*'],
      }),
    );

    /*
      Create SopsSecret instances here. Refer to README.md for more information.

      e.g.

      new SopsSecret(this, 'ExampleSecret', {
        path: path.join(__dirname, '..', 'secrets', 'my-secret.txt'),
        kmsKeyArn: props.sopsMasterKeyArn,
        secretKmsKeyArn: this.secretsManagerKmsKey.keyArn,
        secretName: 'acme-inc/my-secret',
        secretDescription: 'Just an example secret!',
        secretTags: props.commonTags,
      });
    */
  }
}
