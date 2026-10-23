package context

import j "companion-helper/internal/jsondoc"

// EventSource yields carried events lazily, loading and verifying each record only when it is reached.
type EventSource func() (*Selection, error)

// Select renders one candidate shape: 1 fits as many events as possible, 2 fits within half a failed block, 3 drops the
// diff of a single carried event and 4 is the header-only floor. A nil result means the shape does not apply.
func Select(shape int, template []byte, next EventSource, state *Record, stateWanted bool, generation, instructions, provider string,
	failedBlockBytes *int) (*Rendering, error) {
	if shape < 1 || shape > 4 || stateWanted && state == nil || failedBlockBytes != nil && (*failedBlockBytes < 1 || *failedBlockBytes > MaximumBlockBytes) {
		return nil, j.ErrInvalid
	}
	if shape == 2 && failedBlockBytes == nil {
		return nil, nil
	}
	first, err := next()
	if err != nil {
		return nil, err
	}
	if first != nil && !stateWanted {
		return nil, j.ErrInvalid
	}
	render := func(selected []Selection, selectedState *Record, degraded *string, omitDiff, omitWarnings bool, maximum int) (*Rendering, error) {
		return Render(template, selected, selectedState, generation, degraded, omitDiff, omitWarnings, instructions, provider, maximum)
	}
	firstOnly := func() []Selection {
		if first == nil {
			return []Selection{}
		}
		return []Selection{*first}
	}
	wantedState := func() *Record {
		if stateWanted {
			return state
		}
		return nil
	}
	floor := func() (*Rendering, error) {
		degraded := "eventTooLarge"
		if stateWanted {
			degraded = "stateTooLarge"
		}
		result, err := render(firstOnly(), nil, &degraded, true, false, MaximumBlockBytes)
		if err != nil {
			return nil, err
		}
		if result == nil {
			if result, err = render(firstOnly(), nil, &degraded, true, true, MaximumBlockBytes); err != nil {
				return nil, err
			}
		}
		if result == nil {
			return nil, j.ErrInvalid
		}
		return result, nil
	}
	withoutDiff := func() (*Rendering, error) {
		var degraded *string
		if first != nil {
			value := "eventTooLarge"
			degraded = &value
		}
		result, err := render(firstOnly(), wantedState(), degraded, first != nil, false, MaximumBlockBytes)
		if err != nil {
			return nil, err
		}
		if result == nil {
			return floor()
		}
		return result, nil
	}
	switch shape {
	case 4:
		return floor()
	case 3:
		return withoutDiff()
	}
	maximum := MaximumBlockBytes
	if shape == 2 {
		maximum = *failedBlockBytes / 2
	}
	if maximum < 1 {
		return nil, nil
	}
	empty, err := render([]Selection{}, wantedState(), nil, false, false, maximum)
	if err != nil {
		return nil, err
	}
	if empty == nil {
		if shape == 1 {
			return withoutDiff()
		}
		return nil, nil
	}
	selected := []Selection{}
	size := int64(len(empty.Bytes))
	current := first
	for current != nil {
		separator := int64(0)
		if len(selected) > 0 {
			separator = 1
		}
		candidate := size + EventBytes(*current) + separator
		if candidate > int64(maximum) {
			break
		}
		selected = append(selected, *current)
		size = candidate
		if current, err = next(); err != nil {
			return nil, err
		}
	}
	if first != nil && len(selected) == 0 {
		if shape == 1 {
			return withoutDiff()
		}
		return nil, nil
	}
	chosen, err := render(selected, wantedState(), nil, false, false, maximum)
	if err != nil {
		return nil, err
	}
	if chosen == nil || int64(len(chosen.Bytes)) != size {
		return nil, j.ErrInvalid
	}
	return chosen, nil
}
