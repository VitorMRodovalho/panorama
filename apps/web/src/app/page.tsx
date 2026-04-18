import { redirect } from 'next/navigation';

/**
 * The root route is just a router: if the session cookie is present
 * we go to /assets (middleware would already redirect logged-out
 * users to /login). Keeping this server component avoids a flash of
 * unauthenticated content.
 */
export default function Home(): never {
  redirect('/assets');
}
