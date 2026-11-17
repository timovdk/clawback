"""Tests for the parts of scripts/build_data.py that decide which trips and stop names end up in the app."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'scripts'))

import build_data as bd  # noqa: E402


def stop(name, platform='', lat=52.0, lon=5.0, town='Utrecht'):
    return {'town': town, 'name': name, 'platform': platform, 'lat': lat, 'lon': lon}


class UovTripTest(unittest.TestCase):
    def test_uov_agency_with_known_operator(self):
        self.assertTrue(bd.is_uov_trip('UOV', 'CXX:U028:1001'))
        self.assertTrue(bd.is_uov_trip('UOV', 'KEOLIS:5302:12'))

    def test_night_lines_filed_under_transdev(self):
        self.assertTrue(bd.is_uov_trip('TRANSDEV', 'CXX:U409:6001'))  # N9

    def test_other_transdev_concessions_stay_out(self):
        self.assertFalse(bd.is_uov_trip('TRANSDEV', 'CXX:F200:1'))  # Gooi en Vechtstreek
        self.assertFalse(bd.is_uov_trip('TRANSDEV', 'CXX:Z436:1'))

    def test_unknown_operator(self):
        self.assertFalse(bd.is_uov_trip('UOV', 'ARR:U1:1'))


class StopNameTest(unittest.TestCase):
    def test_strip_platform(self):
        self.assertEqual(bd.strip_platform('CS Jaarbeurszijde (C2)', 'C2'), 'CS Jaarbeurszijde')
        self.assertEqual(bd.strip_platform('Marconi (hoog)', ''), 'Marconi (hoog)')
        self.assertEqual(bd.strip_platform('Busstation Lekbrug (Oost)', 'G'), 'Busstation Lekbrug (Oost)')

    def test_platform_in_name_merges_with_the_rest(self):
        stops = [stop('CS Jaarbeurszijde', 'C3'), stop('CS Jaarbeurszijde (C2)', 'C2', lat=52.001)]
        bd.merge_place_names(stops)
        self.assertEqual({s['name'] for s in stops}, {'CS Jaarbeurszijde'})

    def test_close_spellings_of_one_place_merge(self):
        stops = [
            stop('Busstat. Lekbrug Oost (E)', 'E', 52.0, 5.0, 'Vianen'),
            stop('Busstation Lekbrug (Oost)', 'G', 52.00005, 5.0, 'Vianen'),  # ~6 m
            stop('Station', 'A', 52.1, 5.1, 'Houten'),
            stop('Station Houten', 'C', 52.10006, 5.1, 'Houten'),  # ~7 m
        ]
        bd.merge_place_names(stops)
        self.assertEqual([s['name'] for s in stops],
                         ['Busstation Lekbrug (Oost)', 'Busstation Lekbrug (Oost)', 'Station Houten', 'Station Houten'])

    def test_distinct_nearby_stops_stay_apart(self):
        stops = [
            stop('Marconi (hoog)', '', 52.0, 5.0),
            stop('Marconi (laag)', '', 52.0005, 5.0),  # ~55 m
            stop('Kerkplein', '', 52.0, 5.0001),  # close, but another name
            stop('Station', '', 52.0, 5.0, town='Bunnik'),  # other town
        ]
        bd.merge_place_names(stops)
        self.assertEqual([s['name'] for s in stops], ['Marconi (hoog)', 'Marconi (laag)', 'Kerkplein', 'Station'])


if __name__ == '__main__':
    unittest.main()
