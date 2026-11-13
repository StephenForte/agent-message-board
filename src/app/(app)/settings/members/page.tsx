import { listMembers } from '../../../../domain/members';
import { raiseDomain, requireOrgOwnerPage } from '../../session';
import { InviteMemberForm, MemberRow, PendingInviteRow } from './forms';

export const dynamic = 'force-dynamic';

export default async function MembersPage() {
  const principal = await requireOrgOwnerPage();
  let roster: Awaited<ReturnType<typeof listMembers>>;
  try {
    roster = await listMembers(principal);
  } catch (error) {
    raiseDomain(error);
  }
  return <div className="space-y-8">
    <h1 className="text-2xl font-semibold">Organization members</h1>
    <section aria-labelledby="owner-heading" className="space-y-2">
      <h2 id="owner-heading" className="text-xl font-medium">Owner</h2>
      {roster.owner ? <div className="rounded border p-3">
        <p className="font-medium">{roster.owner.name || roster.owner.email}</p>
        <p className="text-sm text-stone-600">{roster.owner.email}</p>
      </div> : <p>No owner on this organization.</p>}
    </section>
    <section aria-labelledby="members-heading" className="space-y-3">
      <h2 id="members-heading" className="text-xl font-medium">Members</h2>
      {roster.members.length === 0 ? <p>No members yet.</p> : <ul className="space-y-3">
        {roster.members.map((member) => <MemberRow key={member.id} id={member.id} email={member.email}
          name={member.name} joinedAt={member.joinedAt} canCreateProjects={member.canCreateProjects} />)}
      </ul>}
    </section>
    <section aria-labelledby="invites-heading" className="space-y-3">
      <h2 id="invites-heading" className="text-xl font-medium">Pending invites</h2>
      {roster.invites.length === 0 ? <p>No pending invites.</p> : <ul className="space-y-3">
        {roster.invites.map((invite) => <PendingInviteRow key={invite.id} id={invite.id}
          email={invite.email} expiresAt={invite.expiresAt} />)}
      </ul>}
    </section>
    <InviteMemberForm />
  </div>;
}
