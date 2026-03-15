/**
 * Progress bar utilities for the CLI tool.
 * Uses cli-progress for animated terminal progress bars.
 */

import cliProgress from 'cli-progress';
import chalk from 'chalk';

export class ProgressManager {
  private multiBar: cliProgress.MultiBar;
  private bars: Map<string, cliProgress.SingleBar> = new Map();

  constructor() {
    this.multiBar = new cliProgress.MultiBar({
      clearOnComplete: false,
      hideCursor: true,
      format: `  {label} ${chalk.cyan('{bar}')} {percentage}% | {value}/{total} {unit}`,
      barCompleteChar: '\u2588',
      barIncompleteChar: '\u2591',
      barsize: 30,
    }, cliProgress.Presets.shades_grey);
  }

  createBar(id: string, label: string, total: number, unit: string = 'items'): void {
    const paddedLabel = label.padEnd(28);
    const bar = this.multiBar.create(total, 0, { label: paddedLabel, unit });
    this.bars.set(id, bar);
  }

  update(id: string, value: number, payload?: Record<string, string>): void {
    const bar = this.bars.get(id);
    if (bar) {
      bar.update(value, payload);
    }
  }

  increment(id: string, delta: number = 1): void {
    const bar = this.bars.get(id);
    if (bar) {
      bar.increment(delta);
    }
  }

  stop(): void {
    this.multiBar.stop();
  }

  /** Print a section header outside the progress bars */
  static header(text: string): void {
    console.log('');
    console.log(chalk.bold.white(text));
  }

  /** Print the final report */
  static report(lines: string[]): void {
    console.log('');
    console.log(chalk.bold('═'.repeat(55)));
    for (const line of lines) {
      console.log(`  ${line}`);
    }
    console.log(chalk.bold('═'.repeat(55)));
    console.log('');
  }

  /** Print the startup banner */
  static banner(version: string, info: Record<string, string>): void {
    console.log('');
    console.log(chalk.bold('═'.repeat(55)));
    console.log(chalk.bold.white(`  SPO Chunk Generator v${version}`));
    for (const [key, value] of Object.entries(info)) {
      console.log(`  ${chalk.gray(key)}: ${value}`);
    }
    console.log(chalk.bold('═'.repeat(55)));
    console.log('');
  }
}
