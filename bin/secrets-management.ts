#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { SecretsManagementStack } from '../lib/secrets-management-stack';
import { SopsKeyStack } from '../lib/sops-key-stack';

const app = new cdk.App();

/**
 * AWS organisation id.
 *
 * This is used to grant access to principals in accounts in the organisation
 */
const ORG_ID = 'abcd'; // FIXME
/**
 * Primary AWS region used to store secrets.
 *
 * The primary KMS key is created in this region also.
 */
const PRIMARY_REGION = 'ap-southeast-2';
/**
 * Secondary AWS region where a second KMS key is created as backup against the
 * total destruction of the primary region
 */
const SECONDARY_REGION = 'us-east-1';
/**
 * AWS account to store secrets in
 */
const SECRETS_ACCOUNT_ID = '999999999999'; // FIXME

const sopsPrimaryKeyStack = new SopsKeyStack(app, 'SopsPrimaryKeyStack', {
  organisationId: ORG_ID,
  env: {
    account: SECRETS_ACCOUNT_ID,
    region: PRIMARY_REGION,
  },
});

new SopsKeyStack(app, 'SopsSecondaryKeyStack', {
  organisationId: ORG_ID,
  env: {
    account: SECRETS_ACCOUNT_ID,
    region: SECONDARY_REGION,
  },
});

new SecretsManagementStack(app, 'SecretsManagementStack', {
  sopsMasterKeyArn: sopsPrimaryKeyStack.key.keyArn,
  env: {
    account: SECRETS_ACCOUNT_ID,
    region: PRIMARY_REGION,
  },
  organisationId: ORG_ID,
});
