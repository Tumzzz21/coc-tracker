# Tests for the pure sync helpers in sync.py (no API, no DB).
import sync


class TestWarKey:
    def test_key_uses_end_time_and_tag(self):
        assert sync._war_key("2026-09-30T04:14:47.000Z", "#TAG") == (
            "war-2026-09-30T04:14:47.000Z-#TAG"
        )

    def test_missing_parts_degenerate_to_empty(self):
        assert sync._war_key(None, None) == "war--"

    def test_live_and_finished_wars_share_a_key(self):
        # The whole point of the key: currentwar and warlog rows for the same
        # war must collide so the live row is adopted instead of duplicated.
        assert sync._war_key("2026-09-30T04:14:47.000Z", "#OPP") == (
            sync._war_key("2026-09-30T04:14:47.000Z", "#OPP")
        )


class TestPlausibleWar:
    def _war(self, **overrides):
        war = {
            "opponent": {"tag": "#OPP", "name": "Enemy", "stars": 30},
            "clan": {"tag": "#US", "stars": 42},
            "teamSize": 15,
        }
        war.update(overrides)
        return war

    def test_normal_war_is_plausible(self):
        assert sync._plausible_war(self._war()) is True

    def test_missing_opponent_tag_rejected(self):
        # Exactly the shape of the junk row that once stored
        # external_key='war-20260910T041447.000Z-' with stars_for=694.
        assert sync._plausible_war(self._war(opponent={"name": "x"})) is False

    def test_stars_over_cap_rejected(self):
        # teamSize 15 * 3 stars = 45 max; 694 cannot be real.
        assert sync._plausible_war(self._war(clan={"stars": 694})) is False

    def test_enemy_stars_over_cap_rejected(self):
        war = self._war(opponent={"tag": "#OPP", "stars": 100})
        assert sync._plausible_war(war) is False

    def test_missing_team_size_does_not_crash(self):
        war = self._war()
        del war["teamSize"]
        assert sync._plausible_war(war) is True

    def test_stars_at_exact_cap_accepted(self):
        assert sync._plausible_war(self._war(clan={"stars": 45})) is True
