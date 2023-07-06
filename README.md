# CDK Sops Secrets Management

This a reference project using [Mozilla Sops][sops] and [AWS CDK][cdk] to securely store secrets in Git and sync to AWS Secrets Manager.

## Setup

### Install dependencies

This project requires Node v16.19.0 or greater.

```bash
npm install
```

### Install sops

In order to add secrets to this repository you MUST install [sops][sops] locally. 

On Mac, sops can be easily installed via Homebrew:

```
brew install sops
```

## Stacks

This project defines 2 CDK stacks.
You MUST edit `bin/secrets-management.ts` to provide configuration values.
Refer to the comments in this file for the values you need to supply.

### SopsKeyStack

This stack defines a single resource, a KMS key which is used by [sops][sops] to encrypt and decrypt secrets.
This stack is deployed into 2 regions, `ap-southeast-2` and `us-east-1`. 
We refer to each as the primary and secondary keys respectively. 
Both keys are used when encrypting secrets. 
Only one key, the primary, is used to decrypt secrets though either key can be used.
Two keys are used for redundancy in the event of the total destruction of an AWS region.

Each key is created with a policy granting the `kms:Decrypt` action to requests originating withing the AWS Organisation.

Typically, you should not need to touch this stack as it's unlikely to require changes once deployed.

### SecretsManagementStack

This stack is used to contain several `SopsSecret` instances. 
This stack has a dependency on the primary `SopsKeyStack` instance as it requires a reference to the primary KMS key in order to decrypt keys prior to storing in AWS Secrets Manager.

## Encrypting a secret

Creating a secret requires your local AWS credentials to have the appropriate permissions to access the primary and secondary KMS keys created by `SopsKeyStack`.
This can be achieved by simply assuming a role in the target Secrets account where the role has permissions to access the KMS key.
If you are assuming a role it will need permission to perform encrypt/decrypt operations using the keys. 

It's recommended you define your primary and secondary key arns in a `.sops.yaml` file.
Refer to the [sops README](https://github.com/getsops/sops#using-sops-yaml-conf-to-select-kms-pgp-for-new-files) on how to do this.

Run the following to open a secret for editing in your shell's default editor.
The following example will store your encrypted secret in file named `my-secret.json` in the `secrets` directory in this repositories root.

```bash
sops secrets/my-secret.json
```

Secret file extension must be `.json`, `.yaml`, `.env` or `.txt`.
Please note any leading and trailing whitespace is trimmed before writing into Secrets Manager.

## Adding secret to SecretsManagementStack

For each secret you create on-disk a `SopsSecret` construct MUST be instantiated in `lib/secrets-management-stack.ts`.

```typescript
new SopsSecret(this, 'MySecret', {
  path: path.join(__dirname, '..', 'secrets', 'my-secret.json'),
  kmsKeyArn: props.sopsMasterKeyArn,
  secretName: 'my-secret',
});
```

The secret's description and tags can optionally be defined with `secretDescription` and `secretTags` respectively.

```typescript
new SopsSecret(this, 'MySecret', {
  path: path.join(__dirname, '..', 'secrets', 'my-secret.json'),
  kmsKeyArn: props.sopsMasterKeyArn,
  secretName: 'my-secret',
  secretDescription: 'My super-secret secret!',
  secretTags: [
    {
      key: 'foo',
      value: 'bar',
    },
  ]
});
```

To grant AWS principals access to the secret you must define `secretPolicy`. 
Note, the principal must *exist* or the deployment will fail.

```typescript
new SopsSecret(this, 'MySecret', {
  path: path.join(__dirname, '..', 'secrets', 'my-secret.json'),
  kmsKeyArn: props.sopsMasterKeyArn,
  secretName: 'my-secret',
  secretDescription: 'My super-secret secret!',
  secretPolicy: new iam.PolicyDocument({
    statements: [
      new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue'],
        principals: [new iam.AccountPrincipal(999999999999)],
        resources: ['*'],
      }),
    ],
  }),
});
```

Secret replication can be configured via `secretReplicaRegions`.

```typescript
new SopsSecret(this, 'MySecret', {
  path: path.join(__dirname, '..', 'secrets', 'my-secret.json'),
  kmsKeyArn: props.sopsMasterKeyArn,
  secretName: 'my-secret',
  secretReplicaRegions: [
    {
      region: 'us-east-2',
    },
    {
      region: 'us-east-1',
    },
  ],
});
```

## Known issues

### Updating secrets

Updating secrets too-frequently MAY be problematic. 
The custom resource used by `SopsSecret` calls the [UpdateSecret API][update-secret-api] which has the following limitation:

> We recommend you avoid calling UpdateSecret at a sustained rate of more than once every 10 minutes. When you call UpdateSecret to update the secret value, Secrets Manager creates a new version of the secret. Secrets Manager removes outdated versions when there are more than 100, but it does not remove versions created less than 24 hours ago. If you update the secret value more than once every 10 minutes, you create more versions than Secrets Manager removes, and you will reach the quota for secret versions.

### Deleting secrets

Deleting secrets is an asynchronous operation. 
The custom resource used by `SopsSecret` calls the [DeleteSecret API][delete-secret-api] with `ForceDeleteWithoutRecovery = true`, despite this, deletion is *not* instant. 
This should only be an issue if you delete a `SopsSecret` and then create a new `SopsSecret` with the same `secretName` a short time later.

> Secrets Manager performs the permanent secret deletion at the end of the waiting period as a background task with low priority. There is no guarantee of a specific time after the recovery window for the permanent delete to occur.

[sops]: https://github.com/mozilla/sops
[cdk]: https://docs.aws.amazon.com/cdk/v2/guide/home.html
[update-secret-api]: https://docs.aws.amazon.com/secretsmanager/latest/apireference/API_UpdateSecret.html
[delete-secret-api]: https://docs.aws.amazon.com/secretsmanager/latest/apireference/API_DeleteSecret.html

## Related articles
* https://aws.amazon.com/blogs/database/design-patterns-to-access-cross-account-secrets-stored-in-aws-secrets-manager/