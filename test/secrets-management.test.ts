import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { SopsSecret } from '../lib/sops-secret';

const MOCK_SOPS_MASTER_KEY =
  'arn:aws:kms:ap-southeast-2:123456789123:key/00000000-0000-0000-0000-000000000000';

describe('SopsSecret', () => {
  test('synthesises as we expect', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app);

    new SopsSecret(stack, 'SampleSecretJson', {
      path: path.join(__dirname, 'secrets', 'sample-secret.json'),
      kmsKeyArn: MOCK_SOPS_MASTER_KEY,
      secretName: '/sops/sample-secret-json',
    });

    const template = Template.fromStack(stack);

    template.resourceCountIs('AWS::Lambda::Function', 2);
    template.resourceCountIs('AWS::Lambda::LayerVersion', 1);
    template.resourceCountIs('Custom::SopsSecret', 1);
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs18.x',
    });
  });

  test('lambda resources are instantiated once at-most', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app);

    for (let i = 0; i < 10; i++) {
      new SopsSecret(stack, `SampleSecretJson${i}`, {
        path: path.join(__dirname, 'secrets', 'sample-secret.json'),
        kmsKeyArn: MOCK_SOPS_MASTER_KEY,
        secretName: `/sops/sample-secret-json-${i}`,
      });
    }

    const template = Template.fromStack(stack);

    template.resourceCountIs('AWS::Lambda::Function', 2);
    template.resourceCountIs('AWS::Lambda::LayerVersion', 1);
    template.resourceCountIs('Custom::SopsSecret', 10);
  });

  test('kms key is added to lambda role policy', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app);

    new SopsSecret(stack, `SampleSecretJson`, {
      path: path.join(__dirname, 'secrets', 'sample-secret.json'),
      kmsKeyArn: MOCK_SOPS_MASTER_KEY,
      secretName: `/sops/sample-secret-json`,
    });

    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          {
            Action: ['kms:Decrypt', 'kms:DescribeKey', 'kms:GenerateDataKey'],
            Effect: 'Allow',
            Resource: MOCK_SOPS_MASTER_KEY,
          },
        ]),
      }),
    });
  });

  test('globally unique secret name', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app);

    new SopsSecret(stack, `SampleSecretJson1`, {
      path: path.join(__dirname, 'secrets', 'sample-secret.json'),
      kmsKeyArn: MOCK_SOPS_MASTER_KEY,
      secretName: `/sops/sample-secret-json`,
    });

    // Second instance should throw error as there is aleady
    // a SopsSecret with this secretName
    expect(() => {
      new SopsSecret(stack, `SampleSecretJson2`, {
        path: path.join(__dirname, 'secrets', 'sample-secret.json'),
        kmsKeyArn: MOCK_SOPS_MASTER_KEY,
        secretName: `/sops/sample-secret-json`,
      });
    }).toThrow(Error);
  });
});
