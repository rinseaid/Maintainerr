import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity()
export class PlexMetadataCache {
  @PrimaryColumn({ type: 'varchar' })
  ratingKey: string;

  @Column({ type: 'varchar' })
  metadataJson: string; // JSON-serialized PlexMetadata

  @Column({ type: 'datetime' })
  cachedAt: Date;
}
