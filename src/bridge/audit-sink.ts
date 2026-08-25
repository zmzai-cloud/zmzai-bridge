import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { AuditRecord } from "../shared/protocol.js";

/**
 * 云端审计收集：客户端经 audit_report 上送的审计记录。
 *
 * 内存保留最近 MAX_RECORDS 条（倒序查询）；可选 JSONL 落盘（AUDIT_FILE_PATH）
 * 作为持久化备份。生产可替换为写审计存储 / 归集到日志管道。
 */
export class AuditSink {
  private records: AuditRecord[] = [];

  constructor(
    private readonly filePath: string | null,
    private readonly maxRecords = 1000,
  ) {}

  append(record: AuditRecord): void {
    this.records.push(record);
    if (this.records.length > this.maxRecords) {
      this.records.splice(0, this.records.length - this.maxRecords);
    }
    if (this.filePath) {
      try {
        mkdirSync(dirname(this.filePath), { recursive: true });
        appendFileSync(this.filePath, `${JSON.stringify(record)}\n`, "utf8");
      } catch {
        // 落盘失败不影响内存收集（审计上送是尽力而为的增强，不阻塞工具执行）
      }
    }
  }

  recent(limit = 100): AuditRecord[] {
    return this.records.slice(-Math.max(1, limit)).reverse();
  }

  count(): number {
    return this.records.length;
  }
}
