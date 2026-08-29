# Delta for Studio UI Honesty

## MODIFIED Requirements

### Requirement: Unavailable write actions are disabled with a stated reason

Add Record and Save Changes MUST be enabled when a real backend write path exists to
persist the result, and MUST remain disabled (not merely relabeled) with a stated reason
whenever no such backend is available. Delete MUST additionally require Safe Updates to
be disabled and explicit confirmation, per `studio-write-guards`, independent of backend
availability. Create Table submit MUST remain disabled unconditionally in this change,
since no table-creation write endpoint exists yet.
(Previously: Add Record, Save Changes, Discard, and Create Table submit were disabled
unconditionally because no write endpoint existed at all.)

#### Scenario: Add Record is enabled with a real backend

- GIVEN a real backend write path exists for the active table
- WHEN the user inspects "Add Record"
- THEN the control is enabled and, on submit, creates a row via the write path

#### Scenario: Add Record is disabled without a backend

- GIVEN no real backend write path exists
- WHEN the user inspects or clicks "Add Record"
- THEN the control is disabled, carries a tooltip stating row editing is unavailable,
  and no record is added to the store

#### Scenario: Save Changes reflects real backend availability

- GIVEN the user has edited a record
- WHEN no real backend write path exists
- THEN "Save Changes" is disabled with a tooltip explaining edits are not persisted
- AND when a real backend write path exists, "Save Changes" is enabled and persists
  the edit

#### Scenario: Create Table submit remains disabled

- GIVEN the Create Table modal is open with valid input
- WHEN the user attempts to submit
- THEN the submit control is disabled with the same stated reason and no table is
  pushed to the store
</content>
