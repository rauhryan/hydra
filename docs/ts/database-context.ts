// database-context.ts
/**
 * Demonstrates using Context with Resources.
 * 
 * KEY INSIGHT: Context is scoped to the operation tree. When you set context
 * inside a resource, operations SPAWNED from within that resource can see it.
 * But operations outside the resource cannot.
 * 
 * Pattern: Use a resource that sets context, then do work inside it.
 */
import type { Operation, Context } from 'effection';
import { main, createContext, resource, ensure, spawn, sleep } from 'effection';

interface DatabaseConnection {
  query: (sql: string) => string;
}

const DatabaseContext: Context<DatabaseConnection> = createContext<DatabaseConnection>('database');

// Repository that uses the context
function* findUsers(): Operation<string> {
  const db: DatabaseConnection = yield* DatabaseContext.expect();
  return db.query('SELECT * FROM users');
}

function* findPosts(): Operation<string> {
  const db: DatabaseConnection = yield* DatabaseContext.expect();
  return db.query('SELECT * FROM posts');
}

/**
 * A resource that establishes a database connection and sets context.
 * The callback runs INSIDE the resource scope, so it can access context.
 */
function* withDatabase<T>(work: () => Operation<T>): Operation<T> {
  return yield* resource<T>(function*(provide) {
    console.log('Connecting to database...');
    
    const connection: DatabaseConnection = {
      query: (sql: string) => {
        console.log('Executing:', sql);
        return JSON.stringify([{ id: 1, name: 'Test' }]);
      },
    };
    
    yield* ensure(() => console.log('Disconnecting from database...'));
    
    // Set context - visible to work() and anything it spawns
    yield* DatabaseContext.set(connection);
    
    // Run the work and provide its result
    const result: T = yield* work();
    yield* provide(result);
  });
}

await main(function*() {
  // Use withDatabase to run operations that need database access
  const result = yield* withDatabase(function*() {
    // These operations run INSIDE the resource scope, so they see the context
    const users = yield* findUsers();
    const posts = yield* findPosts();
    
    return { users, posts };
  });
  
  console.log('Users:', result.users);
  console.log('Posts:', result.posts);
  console.log('Done!');
});
