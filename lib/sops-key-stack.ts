import { Stack, StackProps } from 'aws-cdk-lib';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface ISopsKeyStackProps extends StackProps {
  /**
   * Organisation id
   */
  organisationId: string;
}

export class SopsKeyStack extends Stack {
  readonly key: kms.Key;

  constructor(scope: Construct, id: string, props: ISopsKeyStackProps) {
    super(scope, id, props);

    this.key = new kms.Key(this, 'SopsKey', {
      alias: 'sops-key',
    });
    this.key.grantDecrypt(new iam.OrganizationPrincipal(props.organisationId));
  }
}
