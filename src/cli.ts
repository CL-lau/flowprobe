#!/usr/bin/env node
import { Command } from 'commander';
import { registerTask } from './command.js';
import { errorInfo } from './errors.js';
const program = new Command()
  .name('flowprobe')
  .description('Execute browser tasks directly')
  .version('0.2.0');
registerTask(program);
try {
  await program.parseAsync();
} catch (error) {
  console.error(errorInfo(error));
  process.exitCode = 2;
}
