import type { ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { IconChevronLeft, IconSearch } from './Icons';

export function AppBar({
  title,
  wordmark,
  back,
  actions,
  showSearch = true,
}: {
  title?: string;
  wordmark?: boolean;
  back?: string | true;
  actions?: ReactNode;
  showSearch?: boolean;
}) {
  const navigate = useNavigate();
  return (
    <header className="appbar">
      {back ? (
        <button
          className="btn btn--ghost btn--icon"
          onClick={() => (back === true ? navigate(-1) : navigate(back))}
          aria-label="Back"
        >
          <IconChevronLeft />
        </button>
      ) : null}
      {wordmark ? (
        <span className="appbar__brand grow">
          <span className="appbar__wordmark">AEROBOOK</span>
        </span>
      ) : (
        <h1 className="appbar__title">{title}</h1>
      )}
      {actions}
      {showSearch ? (
        <Link className="btn btn--ghost btn--icon" to="/search" aria-label="Search">
          <IconSearch />
        </Link>
      ) : null}
    </header>
  );
}
