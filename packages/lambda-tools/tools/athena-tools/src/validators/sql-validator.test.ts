import { validateSql } from './sql-validator.js';

describe('validateSql', () => {
  describe('valid queries', () => {
    it('should accept a simple SELECT query', () => {
      const result = validateSql('SELECT * FROM users');
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should accept SELECT with WHERE clause', () => {
      const result = validateSql("SELECT id, name FROM users WHERE status = 'active'");
      expect(result.valid).toBe(true);
    });

    it('should accept SELECT with JOIN', () => {
      const result = validateSql(
        'SELECT u.name, o.total FROM users u JOIN orders o ON u.id = o.user_id'
      );
      expect(result.valid).toBe(true);
    });

    it('should accept SELECT with database-qualified table', () => {
      const result = validateSql('SELECT * FROM mydb.users');
      expect(result.valid).toBe(true);
    });

    it('should accept WITH (CTE) queries', () => {
      const result = validateSql(
        'WITH active_users AS (SELECT * FROM users WHERE active = true) SELECT * FROM active_users'
      );
      expect(result.valid).toBe(true);
    });

    it('should accept SHOW queries', () => {
      const result = validateSql('SHOW TABLES');
      expect(result.valid).toBe(true);
    });

    it('should accept DESCRIBE queries', () => {
      const result = validateSql('DESCRIBE users');
      expect(result.valid).toBe(true);
    });

    it('should accept EXPLAIN queries', () => {
      const result = validateSql('EXPLAIN SELECT * FROM users');
      expect(result.valid).toBe(true);
    });

    it('should accept queries with trailing semicolon', () => {
      const result = validateSql('SELECT * FROM users;');
      expect(result.valid).toBe(true);
    });

    it('should accept queries with comments', () => {
      const result = validateSql('-- This is a comment\nSELECT * FROM users');
      expect(result.valid).toBe(true);
    });

    it('should accept queries with block comments', () => {
      const result = validateSql('/* comment */ SELECT * FROM users');
      expect(result.valid).toBe(true);
    });

    it('should accept lowercase SELECT', () => {
      const result = validateSql('select * from users');
      expect(result.valid).toBe(true);
    });
  });

  describe('invalid queries', () => {
    it('should reject empty query', () => {
      const result = validateSql('');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('empty');
    });

    it('should reject whitespace-only query', () => {
      const result = validateSql('   ');
      expect(result.valid).toBe(false);
    });

    it('should reject INSERT statements', () => {
      const result = validateSql("INSERT INTO users VALUES (1, 'test')");
      expect(result.valid).toBe(false);
      expect(result.error).toContain('INSERT');
    });

    it('should reject UPDATE statements', () => {
      const result = validateSql("UPDATE users SET name = 'test' WHERE id = 1");
      expect(result.valid).toBe(false);
    });

    it('should reject DELETE statements', () => {
      const result = validateSql('DELETE FROM users WHERE id = 1');
      expect(result.valid).toBe(false);
    });

    it('should reject DROP statements', () => {
      const result = validateSql('DROP TABLE users');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('DROP');
    });

    it('should reject CREATE statements', () => {
      const result = validateSql('CREATE TABLE users (id INT, name STRING)');
      expect(result.valid).toBe(false);
    });

    it('should reject ALTER statements', () => {
      const result = validateSql('ALTER TABLE users ADD COLUMN email STRING');
      expect(result.valid).toBe(false);
    });

    it('should reject TRUNCATE statements', () => {
      const result = validateSql('TRUNCATE TABLE users');
      expect(result.valid).toBe(false);
    });

    it('should reject multiple statements', () => {
      const result = validateSql('SELECT * FROM users; SELECT * FROM orders');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Multiple');
    });

    it('should reject SELECT with embedded DROP via semicolon injection', () => {
      const result = validateSql('SELECT * FROM users; DROP TABLE users');
      expect(result.valid).toBe(false);
    });
  });

  describe('table reference extraction', () => {
    it('should extract simple table reference', () => {
      const result = validateSql('SELECT * FROM users');
      expect(result.valid).toBe(true);
      expect(result.tableReferences).toEqual([{ table: 'users' }]);
    });

    it('should extract database-qualified table reference', () => {
      const result = validateSql('SELECT * FROM mydb.users');
      expect(result.valid).toBe(true);
      expect(result.tableReferences).toEqual([{ database: 'mydb', table: 'users' }]);
    });

    it('should extract multiple table references from JOIN', () => {
      const result = validateSql('SELECT * FROM users u JOIN orders o ON u.id = o.user_id');
      expect(result.valid).toBe(true);
      expect(result.tableReferences).toHaveLength(2);
      expect(result.tableReferences).toContainEqual({ table: 'users' });
      expect(result.tableReferences).toContainEqual({ table: 'orders' });
    });

    it('should deduplicate table references', () => {
      const result = validateSql('SELECT * FROM users u1 JOIN users u2 ON u1.id = u2.manager_id');
      expect(result.valid).toBe(true);
      // Should only have one 'users' reference
      const usersRefs = result.tableReferences.filter((r) => r.table === 'users');
      expect(usersRefs).toHaveLength(1);
    });

    it('should extract from LEFT JOIN', () => {
      const result = validateSql(
        'SELECT * FROM users LEFT JOIN orders ON users.id = orders.user_id'
      );
      expect(result.valid).toBe(true);
      expect(result.tableReferences).toHaveLength(2);
    });
  });
});
