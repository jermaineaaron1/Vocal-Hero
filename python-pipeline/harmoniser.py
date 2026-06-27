import numpy as np

def harmonise_satb(soprano_norm: list) -> list:
  log_range = np.log2(1050.0 / 80.0)

  def shift(curve, semitones):
    delta = semitones / (12.0 * log_range)
    return [round(max(0.0, min(1.0, v - delta)), 4) for v in curve]

  return [
    {
      "name": "Soprano",
      "rangeMin": 260,
      "rangeMax": 1050,
      "curve": [round(v, 4) for v in soprano_norm],
      "aiGen": True,
      "edits": 0
    },
    {
      "name": "Alto",
      "rangeMin": 175,
      "rangeMax": 700,
      "curve": shift(soprano_norm, 4),
      "aiGen": True,
      "edits": 0
    },
    {
      "name": "Tenor",
      "rangeMin": 130,
      "rangeMax": 525,
      "curve": shift(soprano_norm, 7),
      "aiGen": True,
      "edits": 0
    },
    {
      "name": "Bass",
      "rangeMin": 80,
      "rangeMax": 330,
      "curve": shift(soprano_norm, 12),
      "aiGen": True,
      "edits": 0
    }
  ]
