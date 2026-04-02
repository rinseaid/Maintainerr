import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity()
export class TautulliHistoryCache {
  @PrimaryColumn({ type: 'varchar' })
  cacheKey: string; // "${media_type}:${rating_key}"

  @Column({ type: 'varchar' })
  historyJson: string; // JSON-serialized TautulliHistoryItem[]

  @Column({ type: 'datetime' })
  cachedAt: Date;
}
