import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity()
export class MetadataIdCache {
  @PrimaryColumn({ type: 'varchar' })
  mediaServerId: string;

  @Column({ type: 'varchar' })
  resolvedIds: string; // JSON-serialized ResolvedMediaIds

  @Column({ type: 'datetime' })
  cachedAt: Date;
}
