import { Link } from 'react-router-dom';
import { AppBar } from '../components/AppBar';
import { EmptyState } from '../components/ui';
import { IconPlane } from '../components/Icons';

export default function NotFound() {
  return (
    <>
      <AppBar title="Not found" back />
      <main className="page">
        <EmptyState
          icon={<IconPlane />}
          title="Nothing here"
          body="That page does not exist in AEROBOOK."
          action={<Link className="btn btn--primary" to="/">Back to the dashboard</Link>}
        />
      </main>
    </>
  );
}
