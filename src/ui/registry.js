import PgBackupTool from '../../pg-backup/src/ui/PgBackupTool.jsx';
import MysqlTool from '../../mysql-tool/src/ui/MysqlTool.jsx';
import MysqlPgMigrateTool from '../../mysql-pg-migrate/src/ui/main.jsx';
import SemanticQaTool from '../../semantic-qa/src/ui/SemanticQaTool.jsx';
import GptTool from '../../gpt/src/ui/GptTool.jsx';
import TranscriberTool from '../../transcriber/src/ui/TranscriberTool.jsx';
import SelfVoiceCloneTool from '../../self-voice-clone/src/ui/SelfVoiceCloneTool.tsx';

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
  {
    id: 'semantic-qa',
    name: 'Search Engine',
    description: 'Semantic and conventional search with grounded summaries and complete source documents.',
    path: '/tools/semantic-qa',
    logsPath: '/tools/semantic-qa/logs',
    component: SemanticQaTool,
    runtime: {
      toolId: 'semantic-qa',
      apiBasePath: '/api/tools/semantic-qa',
      homePath: '/tools/semantic-qa',
      logsPath: '/tools/semantic-qa/logs',
      storagePrefix: 'tools.semantic-qa',
    },
  },
  {
    id: 'gpt',
    name: 'GPT',
    description: 'A private conversational researcher grounded exclusively in the local spiritual corpus.',
    path: '/tools/gpt',
    component: GptTool,
    runtime: {
      toolId: 'gpt',
      apiBasePath: '/api/tools/gpt',
      homePath: '/tools/gpt',
      storagePrefix: 'tools.gpt',
    },
  },
  {
    id: 'transcriber',
    name: 'transcriber',
    description: 'Local Whisper transcription for audio and video with TXT and SRT exports.',
    path: '/tools/transcriber',
    logsPath: '/tools/transcriber/logs',
    component: TranscriberTool,
    runtime: {
      toolId: 'transcriber',
      apiBasePath: '/api/tools/transcriber',
      homePath: '/tools/transcriber',
      logsPath: '/tools/transcriber/logs',
      storagePrefix: 'tools.transcriber',
    },
  },
  {
    id: 'self-voice-clone',
    name: 'self-voice-clone',
    description: 'Local personal voice enrollment, diagnostics, adaptation, and text-to-speech synthesis.',
    path: '/tools/self-voice-clone',
    component: SelfVoiceCloneTool,
    runtime: {
      toolId: 'self-voice-clone',
      apiBasePath: '/api/tools/self-voice-clone/v1',
      healthPath: '/api/tools/self-voice-clone/health',
      homePath: '/tools/self-voice-clone',
      storagePrefix: 'tools.self-voice-clone',
    },
  },
];

export function findToolByPath(pathname) {
  const path = String(pathname || '/');
  return TOOLS.find((tool) => path === tool.path || path === tool.logsPath || path.startsWith(tool.path + '/')) || null;
}
