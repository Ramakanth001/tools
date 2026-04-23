import PgBackupTool from '../../pg-backup/src/ui/PgBackupTool.jsx';
import MysqlTool from '../../mysql-tool/src/ui/MysqlTool.jsx';
import MysqlPgMigrateTool from '../../mysql-pg-migrate/src/ui/main.jsx';

export const TOOLS = [
  {
    id: 'pg-backup',
    name: 'pg-backup',
    description: 'Local PostgreSQL backups, schema visualizer, history, and settings.',
    path: '/tools/pg-backup',
    logsPath: '/tools/pg-backup/logs',
    component: PgBackupTool,
    runtime: {
      toolId: 'pg-backup',
      apiBasePath: '/api/tools/pg-backup',
      homePath: '/tools/pg-backup',
      logsPath: '/tools/pg-backup/logs',
      storagePrefix: 'tools.pg-backup',
    },
  },
  {
    id: 'mysql-tool',
    name: 'mysql-tool',
    description: 'Local MySQL backups, connection testing, history, and zip downloads.',
    path: '/tools/mysql-tool',
    logsPath: '/tools/mysql-tool/logs',
    component: MysqlTool,
    runtime: {
      toolId: 'mysql-tool',
      apiBasePath: '/api/tools/mysql-tool',
      homePath: '/tools/mysql-tool',
      logsPath: '/tools/mysql-tool/logs',
      storagePrefix: 'tools.mysql-tool',
    },
  },
  {
    id: 'mysql-pg-migrate',
    name: 'mysql-pg-migrate',
    description: 'MySQL to PostgreSQL schema discovery, mapping, validation, and resumable migration runs.',
    path: '/tools/mysql-pg-migrate',
    logsPath: '/tools/mysql-pg-migrate/logs',
    component: MysqlPgMigrateTool,
    runtime: {
      toolId: 'mysql-pg-migrate',
      apiBasePath: '/api/tools/mysql-pg-migrate',
      homePath: '/tools/mysql-pg-migrate',
      logsPath: '/tools/mysql-pg-migrate/logs',
      storagePrefix: 'tools.mysql-pg-migrate',
    },
  },
];

export function findToolByPath(pathname) {
  const path = String(pathname || '/');
  return TOOLS.find((tool) => path === tool.path || path === tool.logsPath || path.startsWith(tool.path + '/')) || null;
}
