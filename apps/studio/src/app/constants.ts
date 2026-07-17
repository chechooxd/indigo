/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export interface Environment {
  name: string;
  type: string;
  host: string;
}

export const ENVIRONMENTS: Environment[] = [
  { name: 'Production Cluster', type: 'PROD', host: 'us-east-1' },
  { name: 'Staging Environment', type: 'STAGE', host: 'us-east-5' },
  { name: 'Development Sandbox', type: 'DEV', host: 'localhost' },
];
