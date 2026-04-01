import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddMetadataIdCache1772000000000 implements MigrationInterface {
  name = 'AddMetadataIdCache1772000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "metadata_id_cache" (
        "mediaServerId" varchar PRIMARY KEY NOT NULL,
        "resolvedIds"   varchar NOT NULL,
        "cachedAt"      datetime NOT NULL
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "metadata_id_cache"`);
  }
}
