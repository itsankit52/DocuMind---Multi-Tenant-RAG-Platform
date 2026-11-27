/** /settings/invitations — admin invitation management (the backend authorizes every call). */

import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { InvitationsPanel } from '../components/InvitationsPanel';

export function InvitationsPage() {
  const { activeOrganization } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  // "Invite member" on the Members page opens the create dialog here, once
  const [openCreate] = useState(() => !!location.state?.invite);
  useEffect(() => {
    if (location.state?.invite) navigate(location.pathname, { replace: true, state: null });
  }, [location.state, location.pathname, navigate]);

  return (
    <div className="page">
      <InvitationsPanel key={activeOrganization?.organization_id} orgId={activeOrganization?.organization_id} openCreate={openCreate} />
    </div>
  );
}
