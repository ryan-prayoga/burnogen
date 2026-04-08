<?php

namespace App\Http\Resources;

use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\ResourceCollection;

class ProjectTappedCollection extends ResourceCollection
{
    public $collects = ProjectResource::class;

    public function toArray(Request $request): array
    {
        return [
            'tapped' => $this->collection
                ->tap(function ($collection) use ($request) {
                    return $collection->values();
                })
                ->map(function (array $project, int $index) {
                    return [
                        'position' => $index,
                        'identifier' => $project['id'],
                        'owner' => $project['owner_email'],
                        'label' => 'tapped-project',
                    ];
                })
                ->values()
                ->all(),
        ];
    }
}
