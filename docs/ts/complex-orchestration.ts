import type { Operation, Task } from 'effection';
import { main, spawn, all, sleep } from 'effection';

interface User { id: number; name: string; }
interface Post { id: number; title: string; userId: number; }
interface Comment { id: number; text: string; postId: number; }

function* fetchUser(id: number): Operation<User> {
  yield* sleep(100);
  return { id, name: `User ${id}` };
}

function* fetchPosts(userId: number): Operation<Post[]> {
  yield* sleep(150);
  return [
    { id: 1, title: 'First Post', userId },
    { id: 2, title: 'Second Post', userId },
  ];
}

function* fetchComments(postId: number): Operation<Comment[]> {
  yield* sleep(50);
  return [
    { id: 1, text: 'Great!', postId },
    { id: 2, text: 'Thanks!', postId },
  ];
}

await main(function*() {
  console.time('total');

  // Fetch user first
  const user: User = yield* fetchUser(1);

  // Fetch all posts
  const posts: Post[] = yield* fetchPosts(user.id);

  // Fetch comments for all posts in parallel!
  const allComments: Comment[][] = yield* all(
    posts.map(post => fetchComments(post.id))
  );

  console.log({
    user,
    posts,
    comments: allComments.flat(),
  });

  console.timeEnd('total'); // ~300ms total
});

