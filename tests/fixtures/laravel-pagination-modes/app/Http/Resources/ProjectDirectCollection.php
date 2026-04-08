<?php

namespace App\Http\Resources;

use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\ResourceCollection;

class ProjectDirectCollection extends ResourceCollection
{
    public $collects = ProjectResource::class;

    public function toArray(Request $request): array
    {
        return [
            'direct' => $this->collection
                ->map(function (array $project, int $index) use ($request) {
                    return [
                        'position' => $index,
                        'identifier' => $project['id'],
                        'owner' => $project['owner_email'],
                        'label' => 'direct-project',
                    ];
                })
                ->values()
                ->all(),
        ];
    }
}
