import {
  isDatabaseAllowed,
  isTableAllowed,
  validateTableReferences,
  AthenaToolsConfig,
} from './config.js';

describe('config access control', () => {
  // Wildcard config: all databases and tables are permitted
  const wildcardConfig: AthenaToolsConfig = {
    allowedDatabases: ['*'],
    allowedTables: ['*'],
    workgroupName: 'primary',
    outputBucket: 'test-output-bucket',
    region: 'us-east-1',
  };

  // Restricted config: only specific databases are allowed
  const restrictedDbConfig: AthenaToolsConfig = {
    allowedDatabases: ['mydb', 'analytics'],
    allowedTables: ['*'],
    workgroupName: 'primary',
    outputBucket: 'test-output-bucket',
    region: 'us-east-1',
  };

  // Fully restricted config: specific databases and tables
  const restrictedTableConfig: AthenaToolsConfig = {
    allowedDatabases: ['mydb', 'analytics'],
    allowedTables: ['mydb.users', 'mydb.orders', 'analytics.events'],
    workgroupName: 'primary',
    outputBucket: 'test-output-bucket',
    region: 'us-east-1',
  };

  describe('isDatabaseAllowed', () => {
    describe('with wildcard (*)', () => {
      it('should allow any database', () => {
        expect(isDatabaseAllowed('mydb', wildcardConfig)).toBe(true);
        expect(isDatabaseAllowed('secret_db', wildcardConfig)).toBe(true);
        expect(isDatabaseAllowed('production', wildcardConfig)).toBe(true);
        expect(isDatabaseAllowed('anything', wildcardConfig)).toBe(true);
      });
    });

    describe('with specific databases', () => {
      it('should allow configured databases', () => {
        expect(isDatabaseAllowed('mydb', restrictedDbConfig)).toBe(true);
        expect(isDatabaseAllowed('analytics', restrictedDbConfig)).toBe(true);
      });

      it('should deny unconfigured databases', () => {
        expect(isDatabaseAllowed('secret_db', restrictedDbConfig)).toBe(false);
        expect(isDatabaseAllowed('production', restrictedDbConfig)).toBe(false);
      });
    });
  });

  describe('isTableAllowed', () => {
    describe('with wildcard databases and tables (*)', () => {
      it('should allow any table in any database', () => {
        expect(isTableAllowed('mydb', 'users', wildcardConfig)).toBe(true);
        expect(isTableAllowed('secret_db', 'passwords', wildcardConfig)).toBe(true);
        expect(isTableAllowed('anything', 'everything', wildcardConfig)).toBe(true);
      });
    });

    describe('with specific databases and wildcard tables', () => {
      it('should allow all tables in allowed databases', () => {
        expect(isTableAllowed('mydb', 'users', restrictedDbConfig)).toBe(true);
        expect(isTableAllowed('mydb', 'orders', restrictedDbConfig)).toBe(true);
        expect(isTableAllowed('analytics', 'events', restrictedDbConfig)).toBe(true);
      });

      it('should deny tables in non-allowed databases', () => {
        expect(isTableAllowed('secret_db', 'users', restrictedDbConfig)).toBe(false);
      });
    });

    describe('with specific databases and specific tables', () => {
      it('should allow explicitly listed tables', () => {
        expect(isTableAllowed('mydb', 'users', restrictedTableConfig)).toBe(true);
        expect(isTableAllowed('mydb', 'orders', restrictedTableConfig)).toBe(true);
        expect(isTableAllowed('analytics', 'events', restrictedTableConfig)).toBe(true);
      });

      it('should deny tables not in the allow list', () => {
        expect(isTableAllowed('mydb', 'secrets', restrictedTableConfig)).toBe(false);
        expect(isTableAllowed('analytics', 'internal', restrictedTableConfig)).toBe(false);
      });

      it('should deny tables in non-allowed databases', () => {
        expect(isTableAllowed('secret_db', 'users', restrictedTableConfig)).toBe(false);
      });
    });
  });

  describe('validateTableReferences', () => {
    describe('with wildcard config', () => {
      it('should allow all table references', () => {
        const result = validateTableReferences(
          [
            { database: 'any_db', table: 'any_table' },
            { database: 'secret_db', table: 'passwords' },
          ],
          wildcardConfig
        );
        expect(result.allowed).toBe(true);
        expect(result.denied).toHaveLength(0);
      });
    });

    describe('with restricted config', () => {
      it('should pass when all tables are allowed', () => {
        const result = validateTableReferences(
          [
            { database: 'mydb', table: 'users' },
            { database: 'mydb', table: 'orders' },
          ],
          restrictedDbConfig
        );
        expect(result.allowed).toBe(true);
        expect(result.denied).toHaveLength(0);
      });

      it('should fail when any table is denied', () => {
        const result = validateTableReferences(
          [
            { database: 'mydb', table: 'users' },
            { database: 'secret_db', table: 'passwords' },
          ],
          restrictedDbConfig
        );
        expect(result.allowed).toBe(false);
        expect(result.denied).toHaveLength(1);
        expect(result.denied[0]).toEqual({ database: 'secret_db', table: 'passwords' });
      });
    });

    it('should handle empty table list', () => {
      const result = validateTableReferences([], restrictedDbConfig);
      expect(result.allowed).toBe(true);
      expect(result.denied).toHaveLength(0);
    });
  });
});
