import { MigrationInterface, QueryRunner, Table } from 'typeorm';

export class AddPlexCaches1774000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'plex_metadata_cache',
        columns: [
          { name: 'ratingKey', type: 'varchar', isPrimary: true },
          { name: 'metadataJson', type: 'varchar' },
          { name: 'cachedAt', type: 'datetime' },
        ],
      }),
    );
    await queryRunner.createTable(
      new Table({
        name: 'plex_watch_history_cache',
        columns: [
          { name: 'ratingKey', type: 'varchar', isPrimary: true },
          { name: 'historyJson', type: 'varchar' },
          { name: 'cachedAt', type: 'datetime' },
        ],
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('plex_watch_history_cache');
    await queryRunner.dropTable('plex_metadata_cache');
  }
}
