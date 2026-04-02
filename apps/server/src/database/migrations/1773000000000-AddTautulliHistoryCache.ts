import { MigrationInterface, QueryRunner, Table } from 'typeorm';

export class AddTautulliHistoryCache1773000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'tautulli_history_cache',
        columns: [
          { name: 'cacheKey', type: 'varchar', isPrimary: true },
          { name: 'historyJson', type: 'varchar' },
          { name: 'cachedAt', type: 'datetime' },
        ],
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('tautulli_history_cache');
  }
}
