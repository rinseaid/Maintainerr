import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity()
export class PlexWatchHistoryCache {
  @PrimaryColumn({ type: 'varchar' })
  ratingKey: string;

  @Column({ type: 'varchar' })
  historyJson: string; // JSON-serialized PlexSeenBy[]

  @Column({ type: 'datetime' })
  cachedAt: Date;
}
