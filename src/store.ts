import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { configSchema, defaultConfig, type ConfigData } from './config.js'

export class ConfigConflict extends Error {}
export interface ConfigRecord { revision: number; config: ConfigData }
export class ConfigStore {
  private record: ConfigRecord = {revision: 0, config: defaultConfig()}
  constructor(readonly path: string) {}
  async load(): Promise<void> {
    try {
      const value = JSON.parse(await readFile(this.path, 'utf8'))
      if (!Number.isSafeInteger(value.revision) || value.revision < 0) throw new Error('invalid revision')
      this.record = {revision: value.revision, config: configSchema.parse(value.config)}
    } catch (error: any) { if (error.code !== 'ENOENT') throw new Error('无法读取上下文插件配置，请检查持久文件格式与权限。') }
  }
  current(): ConfigData { return structuredClone(this.record.config) }
  revision(): number { return this.record.revision }
  async save(config: ConfigData, expectedRevision: number): Promise<void> {
    // Refresh the revision from disk before committing a write from another tab.
    await this.load()
    if (this.record.revision !== expectedRevision) throw new ConfigConflict('配置已被其他窗口修改，请重新加载后保存。')
    const record = {revision: expectedRevision + 1, config: configSchema.parse(config)}
    await mkdir(dirname(this.path), {recursive: true, mode: 0o700})
    const temp = `${this.path}.${randomUUID()}.tmp`
    try {
      await writeFile(temp, JSON.stringify(record, null, 2) + '\n', {mode: 0o600, flag: 'wx'})
      await rename(temp, this.path)
      this.record = record
    } finally { await unlink(temp).catch(() => {}) }
  }
}
