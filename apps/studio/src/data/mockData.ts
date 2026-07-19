/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Table, RecentSchema, SystemAlert } from '../types';

export const INITIAL_TABLES: Table[] = [
  {
    name: 'users',
    schema: 'public',
    recordCount: 1200000,
    columns: [
      { name: 'id', type: 'UUID', defaultValue: 'gen_random_uuid()', isPK: true, isNN: true, isUQ: true, description: 'Unique identifier for the user entity.' },
      { name: 'email', type: 'VARCHAR(255)', defaultValue: undefined, isPK: false, isNN: true, isUQ: true, description: 'Verified email address for login.' },
      { name: 'full_name', type: 'TEXT', defaultValue: undefined, isPK: false, isNN: false, isUQ: false, description: 'Display name in the interface.' },
      { name: 'created_at', type: 'TIMESTAMPTZ', defaultValue: 'now()', isPK: false, isNN: true, isUQ: false, description: 'Audit timestamp of registration.' },
      { name: 'is_active', type: 'BOOLEAN', defaultValue: 'true', isPK: false, isNN: true, isUQ: false, description: 'Flag for soft-deletion/suspension.' }
    ],
    records: [
      { id: 'clp2j9m0w00004k9l', email: 'alex@indigodb.io', full_name: 'Alex Rivera', role: 'ADMIN', created_at: '2023-11-24, 10:42 AM', verified: true, metadata: JSON.stringify({ last_login: '2023-11-24T10:42:00Z', ip: '192.168.1.42', browser: 'Chrome', platform: 'MacOS' }, null, 2) },
      { id: 'clp2k1b2w00019l1m', email: 'sarah.j@gmail.com', full_name: 'Sarah Jenkins', role: 'USER', created_at: '2023-11-24, 11:15 AM', verified: false, metadata: JSON.stringify({ last_login: '2023-11-24T11:15:00Z', ip: '192.168.1.48', browser: 'Firefox', platform: 'Windows' }, null, 2) },
      { id: 'clp2m3n4w00023x2y', email: 'dev-ops@stack.com', full_name: 'Marcus Chen', role: 'USER', created_at: '2023-11-25, 09:02 AM', verified: true, metadata: JSON.stringify({ last_login: '2023-11-25T09:02:00Z', ip: '192.168.1.99', browser: 'Safari', platform: 'iOS' }, null, 2) },
      { id: 'clp2p5q6w00038z9a', email: 'beta@test.io', full_name: 'John Doe', role: 'USER', created_at: '2023-11-25, 01:45 PM', verified: false, metadata: JSON.stringify({ last_login: '2023-11-25T13:45:00Z', ip: '10.0.0.12', browser: 'Edge', platform: 'Windows' }, null, 2) }
    ]
  },
  {
    name: 'organizations',
    schema: 'public',
    recordCount: 24,
    columns: [
      { name: 'id', type: 'UUID', defaultValue: 'gen_random_uuid()', isPK: true, isNN: true, isUQ: true, description: 'Unique identifier for the organization.' },
      { name: 'name', type: 'VARCHAR(100)', defaultValue: undefined, isPK: false, isNN: true, isUQ: false, description: 'Legal name of the workspace client.' },
      { name: 'slug', type: 'VARCHAR(100)', defaultValue: undefined, isPK: false, isNN: true, isUQ: true, description: 'URL friendly identifier.' },
      { name: 'created_at', type: 'TIMESTAMPTZ', defaultValue: 'now()', isPK: false, isNN: true, isUQ: false, description: 'Creation date.' }
    ],
    records: [
      { id: 'org-1', name: 'Indigo Corporation', slug: 'indigo-corp', created_at: '2023-01-10, 08:00 AM' },
      { id: 'org-2', name: 'Stack Ventures', slug: 'stack-vent', created_at: '2023-03-15, 04:30 PM' },
      { id: 'org-3', name: 'Alpha Agency', slug: 'alpha-agency', created_at: '2023-06-20, 11:15 AM' }
    ]
  },
  {
    name: 'subscriptions',
    schema: 'billing',
    recordCount: 120,
    columns: [
      { name: 'id', type: 'SERIAL', defaultValue: undefined, isPK: true, isNN: true, isUQ: true, description: 'Auto-incrementing primary key.' },
      { name: 'user_id', type: 'UUID', defaultValue: undefined, isPK: false, isNN: true, isUQ: false, description: 'Foreign Key: users.id references.' },
      { name: 'plan_id', type: 'INTEGER', defaultValue: undefined, isPK: false, isNN: true, isUQ: false, description: 'Identifier of active product tier.' },
      { name: 'status', type: 'VARCHAR(20)', defaultValue: "'inactive'", isPK: false, isNN: true, isUQ: false, description: 'Active, grace, or canceled states.' },
      { name: 'renews_at', type: 'TIMESTAMPTZ', defaultValue: undefined, isPK: false, isNN: false, isUQ: false, description: 'Next cycle billing boundary.' }
    ],
    records: [
      { id: 1, user_id: 'clp2j9m0w00004k9l', plan_id: 3, status: 'active', renews_at: '2026-12-31, 11:59 PM' },
      { id: 2, user_id: 'clp2m3n4w00023x2y', plan_id: 2, status: 'canceled', renews_at: '2026-08-15, 11:59 PM' }
    ]
  },
  {
    name: 'projects',
    schema: 'public',
    recordCount: 412,
    columns: [
      { name: 'id', type: 'UUID', defaultValue: 'gen_random_uuid()', isPK: true, isNN: true, isUQ: true, description: 'Unique project identifier.' },
      { name: 'owner_id', type: 'UUID', defaultValue: undefined, isPK: false, isNN: true, isUQ: false, description: 'Reference to creator.' },
      { name: 'title', type: 'VARCHAR(100)', defaultValue: undefined, isPK: false, isNN: true, isUQ: false, description: 'Display title of project workspace.' }
    ],
    records: [
      { id: 'proj-1', owner_id: 'clp2j9m0w00004k9l', title: 'Authentication Service' },
      { id: 'proj-2', owner_id: 'clp2m3n4w00023x2y', title: 'Billing System Dashboard' }
    ]
  },
  {
    name: 'deployments',
    schema: 'public',
    recordCount: 2314,
    columns: [
      { name: 'id', type: 'UUID', defaultValue: undefined, isPK: true, isNN: true, isUQ: true },
      { name: 'project_id', type: 'UUID', defaultValue: undefined, isPK: false, isNN: true, isUQ: false },
      { name: 'env', type: 'VARCHAR(20)', defaultValue: undefined, isPK: false, isNN: true, isUQ: false },
      { name: 'status', type: 'VARCHAR(20)', defaultValue: undefined, isPK: false, isNN: true, isUQ: false }
    ],
    records: [
      { id: 'dep-101', project_id: 'proj-1', env: 'production', status: 'SUCCESS' },
      { id: 'dep-102', project_id: 'proj-2', env: 'staging', status: 'SUCCESS' },
      { id: 'dep-103', project_id: 'proj-1', env: 'development', status: 'FAILED' }
    ]
  },
  {
    name: 'api_keys',
    schema: 'public',
    recordCount: 45,
    columns: [
      { name: 'id', type: 'UUID', defaultValue: undefined, isPK: true, isNN: true, isUQ: true },
      { name: 'key_value', type: 'VARCHAR(100)', defaultValue: undefined, isPK: false, isNN: true, isUQ: true },
      { name: 'label', type: 'VARCHAR(50)', defaultValue: undefined, isPK: false, isNN: true, isUQ: false }
    ],
    records: [
      { id: 'key-1', key_value: 'ind_live_8f3d8a...', label: 'Prod SDK Access' },
      { id: 'key-2', key_value: 'ind_test_41a9c2...', label: 'Local Development Key' }
    ]
  },
  {
    name: 'usage_logs',
    schema: 'analytics',
    recordCount: 4500000,
    columns: [
      { name: 'id', type: 'UUID', defaultValue: 'gen_random_uuid()', isPK: true, isNN: true, isUQ: true },
      { name: 'ip', type: 'VARCHAR(45)', defaultValue: undefined, isPK: false, isNN: false, isUQ: false },
      { name: 'endpoint', type: 'TEXT', defaultValue: undefined, isPK: false, isNN: true, isUQ: false }
    ],
    records: [
      { id: 'log-998', ip: '192.168.1.1', endpoint: '/api/v1/auth/session' },
      { id: 'log-999', ip: '144.20.155.3', endpoint: '/api/v1/billing/checkout' }
    ]
  },
  {
    name: 'error_events',
    schema: 'analytics',
    recordCount: 14500,
    columns: [
      { name: 'id', type: 'UUID', defaultValue: undefined, isPK: true, isNN: true, isUQ: true },
      { name: 'code', type: 'VARCHAR(10)', defaultValue: undefined, isPK: false, isNN: true, isUQ: false },
      { name: 'error_message', type: 'TEXT', defaultValue: undefined, isPK: false, isNN: true, isUQ: false }
    ],
    records: [
      { id: 'err-502', code: '502_BAD_GW', error_message: 'Nginx upstream connection reset by peer' },
      { id: 'err-504', code: '401_UNAUTH', error_message: 'JWT Signature verification expired' }
    ]
  },
  {
    name: 'comments',
    schema: 'public',
    recordCount: 9400,
    columns: [
      { name: 'id', type: 'SERIAL', defaultValue: undefined, isPK: true, isNN: true, isUQ: true },
      { name: 'post_id', type: 'INTEGER', defaultValue: undefined, isPK: false, isNN: true, isUQ: false },
      { name: 'body', type: 'TEXT', defaultValue: undefined, isPK: false, isNN: true, isUQ: false }
    ],
    records: [
      { id: 1, post_id: 12, body: 'This schema looks very robust!' },
      { id: 2, post_id: 15, body: 'Could we optimize the composite indexes?' }
    ]
  },
  {
    name: 'categories',
    schema: 'public',
    recordCount: 30,
    columns: [
      { name: 'id', type: 'SERIAL', defaultValue: undefined, isPK: true, isNN: true, isUQ: true },
      { name: 'title', type: 'VARCHAR(50)', defaultValue: undefined, isPK: false, isNN: true, isUQ: true }
    ],
    records: [
      { id: 1, title: 'Database Administration' },
      { id: 2, title: 'Cloud Infrastructure' }
    ]
  },
  {
    name: 'profiles',
    schema: 'public',
    recordCount: 1200000,
    columns: [
      { name: 'id', type: 'UUID', defaultValue: undefined, isPK: true, isNN: true, isUQ: true },
      { name: 'avatar_url', type: 'TEXT', defaultValue: undefined, isPK: false, isNN: false, isUQ: false },
      { name: 'bio', type: 'TEXT', defaultValue: undefined, isPK: false, isNN: false, isUQ: false }
    ],
    records: [
      { id: 'clp2j9m0w00004k9l', avatar_url: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=100&h=100', bio: 'Database Architect of IndigoDB' }
    ]
  },
  {
    name: 'sessions',
    schema: 'public',
    recordCount: 88000,
    columns: [
      { name: 'id', type: 'UUID', defaultValue: undefined, isPK: true, isNN: true, isUQ: true },
      { name: 'user_id', type: 'UUID', defaultValue: undefined, isPK: false, isNN: true, isUQ: false },
      { name: 'token', type: 'VARCHAR(255)', defaultValue: undefined, isPK: false, isNN: true, isUQ: true }
    ],
    records: [
      { id: 'sess-a', user_id: 'clp2j9m0w00004k9l', token: 'bearer_9f2ea701b' }
    ]
  }
];

export const INITIAL_SCHEMAS: RecentSchema[] = [
  { id: '1', name: 'auth_main_prod', tablesCount: 24, type: 'PostgreSQL', lastModified: '2 mins ago', isActive: true },
  { id: '2', name: 'billing_service_staging', tablesCount: 18, type: 'PostgreSQL', lastModified: '4 hours ago', isActive: false },
  { id: '3', name: 'analytics_warehouse', tablesCount: 56, type: 'BigQuery', lastModified: 'Yesterday', isActive: false },
  { id: '4', name: 'user_preference_store', tablesCount: 8, type: 'MySQL', lastModified: '3 days ago', isActive: false }
];

export const INITIAL_ALERTS: SystemAlert[] = [
  {
    id: 'a1',
    type: 'warning',
    title: 'Migration Failed',
    message: 'auth_service_v3.sql line 44: Foreign key constraint error.',
    timestamp: '5 mins ago'
  },
  {
    id: 'a2',
    type: 'success',
    title: 'Snapshot Created',
    message: 'Daily backup for production_db successful.',
    timestamp: '2 hours ago'
  },
  {
    id: 'a3',
    type: 'info',
    title: 'CLI Updated',
    message: 'IndigoDB-CLI v1.2.4 is now available.',
    timestamp: '1 day ago'
  }
];

export const INITIAL_DSL_CODE = `// IndigoDB schema — the single .indigo language

enum UserRole {
  ADMIN
  USER
  GUEST
}

Table User {
  id        Int      @id @default(autoincrement())
  email     String   @unique @note("Corporate email")
  name      String?
  role      UserRole @default(USER)
  createdAt DateTime @default(now()) @map("created_at")
  posts     Post[]
  profile   Profile?
}

Table Post {
  id       Int     @id @default(autoincrement())
  title    String
  content  String?
  authorId Int     @map("author_id")
  author   User    @relation(fields: [authorId], references: [id])

  @@index([authorId])
}

Table Profile {
  id     Int     @id @default(autoincrement())
  bio    String?
  userId Int     @unique @map("user_id")
  user   User    @relation(fields: [userId], references: [id])
}

TableGroup "Auth" {
  color = "#c3c0ff"

  User
  Post
  Profile
}
`;
