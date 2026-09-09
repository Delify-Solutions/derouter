from dataclasses import fields
from datetime import datetime, timezone
from typing import Any, Dict, List, Mapping, Tuple

import pytest

from derouter.repositories.unit_of_work import (
    LinkedSpendResetWrites,
    budget_cascade_unit_of_work,
    spend_reset_unit_of_work,
)


class FakeBatchTable:
    def __init__(self, table_name: str, calls: List[Tuple[str, Dict[str, Any], Dict[str, Any]]]):
        self._table_name = table_name
        self._calls = calls

    def update(self, where: Mapping[str, object], data: Mapping[str, object]) -> None:
        self._calls.append((self._table_name, dict(where), dict(data)))

    def update_many(self, where: Mapping[str, object], data: Mapping[str, object]) -> None:
        self._calls.append((f"{self._table_name}.update_many", dict(where), dict(data)))


class FakeBatch:
    def __init__(self):
        self.calls: List[Tuple[str, Dict[str, Any], Dict[str, Any]]] = []
        self.commit_count = 0
        self.derouter_verificationtoken = FakeBatchTable("derouter_verificationtoken", self.calls)
        self.derouter_usertable = FakeBatchTable("derouter_usertable", self.calls)
        self.derouter_teamtable = FakeBatchTable("derouter_teamtable", self.calls)
        self.derouter_budgettable = FakeBatchTable("derouter_budgettable", self.calls)
        self.derouter_teammembership = FakeBatchTable("derouter_teammembership", self.calls)
        self.derouter_organizationtable = FakeBatchTable("derouter_organizationtable", self.calls)
        self.derouter_tagtable = FakeBatchTable("derouter_tagtable", self.calls)
        self.derouter_modelaccessgroupbudgettable = FakeBatchTable("derouter_modelaccessgroupbudgettable", self.calls)
        self.derouter_endusertable = FakeBatchTable("derouter_endusertable", self.calls)

    async def commit(self) -> None:
        self.commit_count += 1


async def test_updates_across_tables_share_one_batch_and_commit_once():
    batch = FakeBatch()
    reset_at = datetime(2026, 8, 3, 12, 0, tzinfo=timezone.utc)

    async with spend_reset_unit_of_work(lambda: batch) as uow:
        uow.keys.queue_spend_reset(token="tok-1", budget_reset_at=reset_at)
        uow.users.queue_spend_reset(user_id="user-1", budget_reset_at=reset_at)
        uow.teams.queue_spend_reset(team_id="team-1", budget_reset_at=None)
        assert batch.commit_count == 0

    assert batch.commit_count == 1
    assert batch.calls == [
        ("derouter_verificationtoken", {"token": "tok-1"}, {"spend": 0, "budget_reset_at": reset_at}),
        ("derouter_usertable", {"user_id": "user-1"}, {"spend": 0, "budget_reset_at": reset_at}),
        ("derouter_teamtable", {"team_id": "team-1"}, {"spend": 0, "budget_reset_at": None}),
    ]


async def test_raising_inside_block_skips_commit():
    batch = FakeBatch()

    async def _blow_up_mid_transaction():
        async with spend_reset_unit_of_work(lambda: batch) as uow:
            uow.keys.queue_spend_reset(token="tok-1", budget_reset_at=None)
            raise RuntimeError("boom")

    with pytest.raises(RuntimeError, match="boom"):
        await _blow_up_mid_transaction()

    assert batch.commit_count == 0


async def test_empty_block_still_commits_the_batch():
    batch = FakeBatch()

    async with spend_reset_unit_of_work(lambda: batch):
        pass

    assert batch.commit_count == 1
    assert batch.calls == []


async def test_budget_cascade_dependents_and_window_advance_share_one_batch():
    batch = FakeBatch()
    reset_at = datetime(2026, 8, 3, 12, 0, tzinfo=timezone.utc)
    linked = {"budget_id": {"in": ["budget-1"]}}

    async with budget_cascade_unit_of_work(lambda: batch) as uow:
        uow.team_memberships.queue_spend_zero(where=linked)
        uow.keys.queue_spend_zero(where=linked)
        uow.organizations.queue_spend_zero(where=linked)
        uow.tags.queue_spend_zero(where=linked)
        uow.model_access_groups.queue_spend_zero(where=linked)
        uow.endusers.queue_spend_zero(where={"user_id": {"in": ["enduser-1"]}})
        uow.budgets.queue_window_advance(budget_id="budget-1", budget_reset_at=reset_at)
        assert batch.commit_count == 0

    assert batch.commit_count == 1
    assert batch.calls == [
        ("derouter_teammembership.update_many", linked, {"spend": 0}),
        ("derouter_verificationtoken.update_many", linked, {"spend": 0}),
        ("derouter_organizationtable.update_many", linked, {"spend": 0}),
        ("derouter_tagtable.update_many", linked, {"spend": 0}),
        ("derouter_modelaccessgroupbudgettable.update_many", linked, {"spend": 0}),
        ("derouter_endusertable.update_many", {"user_id": {"in": ["enduser-1"]}}, {"spend": 0}),
        ("derouter_budgettable.update_many", {"budget_id": "budget-1"}, {"budget_reset_at": reset_at}),
    ]


async def test_budget_window_advance_tolerates_a_tier_deleted_mid_chunk():
    """A tier deleted between the read and the commit must not abort the batch:
    ``update`` raises P2025 on a missing row and takes every other write in the
    chunk down with it, while ``update_many`` just matches nothing."""
    batch = FakeBatch()

    async with budget_cascade_unit_of_work(lambda: batch) as uow:
        uow.budgets.queue_window_advance(budget_id="budget-1", budget_reset_at=datetime.now(timezone.utc))

    assert [call[0] for call in batch.calls] == ["derouter_budgettable.update_many"]


async def test_every_cascade_dependent_writes_to_its_own_table_on_the_one_batch():
    """Walks the dataclass instead of naming tables, so a dependent added to
    BudgetCascadeUnitOfWork later cannot go uncovered.

    The named test above only proves the tables it lists, and an unbound
    dependent surfaces as an AttributeError from whichever tests happen to
    open a cascade. This pins the real contract: every field writes, each to a
    distinct table, all on the same batch.
    """
    reset_at = datetime(2026, 8, 3, 12, 0, tzinfo=timezone.utc)
    batches: List[FakeBatch] = []

    def _new_batch() -> FakeBatch:
        # Fresh per call like db.batch_(), unlike the `lambda: batch` above: a
        # second transaction would otherwise alias onto the first and hide.
        batches.append(FakeBatch())
        return batches[-1]

    async with budget_cascade_unit_of_work(_new_batch) as uow:
        writes = [getattr(uow, field.name) for field in fields(uow)]
        for write in writes:
            if isinstance(write, LinkedSpendResetWrites):
                write.queue_spend_zero(where={"budget_id": "budget-1"})
            else:
                write.queue_window_advance(budget_id="budget-1", budget_reset_at=reset_at)

    assert len(batches) == 1, "the cascade must open exactly one transaction"
    batch = batches[0]
    assert len(batch.calls) == len(writes), "a dependent bound to a batch of its own would not land here"
    assert len({call[0] for call in batch.calls}) == len(writes), "two dependents share one table"
    assert batch.commit_count == 1


async def test_budget_cascade_raising_inside_block_skips_commit():
    """A failure part-way through must leave budget_reset_at where it was, so
    the tier is still due on the next tick."""
    batch = FakeBatch()

    async def _blow_up_mid_transaction():
        async with budget_cascade_unit_of_work(lambda: batch) as uow:
            uow.team_memberships.queue_spend_zero(where={"budget_id": {"in": ["budget-1"]}})
            raise RuntimeError("boom")

    with pytest.raises(RuntimeError, match="boom"):
        await _blow_up_mid_transaction()

    assert batch.commit_count == 0
